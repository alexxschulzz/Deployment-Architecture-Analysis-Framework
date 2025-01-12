#!/usr/bin/env node

const amqp = require('amqplib/callback_api');
const mqtt = require("mqtt");
const Minio = require('minio');
const csvParser = require('csv-parser');
const fs = require('fs');
const { createObjectCsvWriter } = require('csv-writer');
const mysql = require('mysql2');

// RabbitMQ connection
const amqpconnection = process.env.RABBITMQCONNECTION
const amqpuser = "user"
const amqppassword = "password"

// Mosquitto connection
const mqttconnection = process.env.MOSQUITTOCONNECTION
const mqttuser = "standardUser"
const mqttpassword = "GreatHHZ4Ever!"

// MySQL-database connection
const DBhostname = process.env.DBCONNECTION
const DBuser = "user"
const DBpassword = "password"

const con = mysql.createConnection({
    host: DBhostname,
    user: DBuser,
    password: DBpassword,
    database: "architectureFilesDB"
});

// MinIO-Client connection
const minioClienthostname = process.env.MINIOCONNECTION
const minioClientaccessKey = "user"
const minioClientsecretKey = "password"

const minioClient = new Minio.Client({
    endPoint: minioClienthostname,
    port: 9000,
    useSSL: false,
    accessKey: minioClientaccessKey,
    secretKey: minioClientsecretKey
});

// MQTT client connection
const client = mqtt.connect(`mqtt://${mqttconnection}`, {
    username: mqttuser,
    password: mqttpassword
});

// Mosquitto input topic
const inputTopic = 'unifiedArchitectures';

// RabbitMQ output queue
const outputQueue = 'GraphAnalysis';

// Function to create the 'GraphArchitectures' table if it doesn't exist
function createGraphArchitecturesTableIfNotExists(callback) {
    const sql = `
        CREATE TABLE IF NOT EXISTS GraphArchitectures (
            architectureid INT NOT NULL,
            user VARCHAR(255) NOT NULL,
            nameofarchitecture VARCHAR(255) NOT NULL,
            architecturetype VARCHAR(255) NOT NULL,
            graphfile VARCHAR(255) NOT NULL,
            analysis INT NOT NULL,
            timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=latin1;
    `;

    con.query(sql, (err) => {
        if (err) {
            console.error(' [!] Error creating table:', err);
            callback(err);
        } else {
            console.log(' [i] Table GraphArchitectures is ready.');
            callback(null);
        }
    });
}

// Connect to RabbitMQ
amqp.connect(`amqp://${amqpuser}:${amqppassword}@${amqpconnection}`, function (error0, connection) {
    if (error0) {
        throw error0;
    }

    connection.createChannel(function (error1, channel) {
        if (error1) {
            throw error1;
        }

        rabbitMQChannel = channel;
        // Set up queues
        rabbitMQChannel.assertQueue(outputQueue, { durable: false });

        console.log(" [i] Output channel was asserted");
    });
});

// Connect to MQTT and process messages
client.on('connect', function () {
    console.log(` [i] Client connected to Mosquitto: ${client.connected}`);
    client.subscribe(inputTopic, (err) => {
        if (err) {
            console.error(` [!] Failed to subscribe to ${inputTopic}:`, err);
        } else {
            console.log(` [i] Subscribed to ${inputTopic}`);
            console.log(` [*] Waiting for messages ...`);
            createGraphArchitecturesTableIfNotExists((err) => {
                if (err) {
                    console.error(' [!] Exiting due to table creation error.');
                    con.end();
                    process.exit(1);
                }
            });
        }
    });
});

client.on("message", (topic, message) => {
    const content = message.toString();
    console.log(" ------------------------")
    console.log(" [x] Received new message");
    console.log(" [x] Content: %s", content);

    try {
        const jsonMessage = JSON.parse(content);
        const fileName = jsonMessage.unifile;
        const architectureName = jsonMessage.nameofarchitecture;
        fetchCSVFromMinIO(fileName, architectureName, content);
    } catch (e) {
        console.error(" [!] Failed to parse JSON: %s", content);
    }
});

// Fetch CSV from MinIO and process it
function fetchCSVFromMinIO(fileName, architectureName, originalMsgContent) {
    minioClient.getObject('architectures', fileName, function (err, dataStream) {
        if (err) {
            console.error(" [!] Error fetching CSV '%s' from MinIO:", fileName, err);
            return;
        }

        const rows = [];
        dataStream.pipe(csvParser())
            .on('data', (row) => {
                rows.push(row);
            })
            .on('end', () => {
                console.log(" [x] CSV '%s' downloaded from MinIO and parsed", fileName);
                processCSVData(rows, fileName, architectureName, originalMsgContent);
            })
            .on('error', (err) => {
                console.error(" [!] Error parsing CSV stream: ", err);
            });
    });
}

// Process CSV data and create two CSV files
function processCSVData(rows, fileName, architectureName, originalMsgContent) {
    const extractedComponentData = [];

    // Create a mapping of relationships
    rows.forEach(row => {
        const source = row.source_component;
        const target = row.target_component;
        const source_type = row.source_component_type;
        const target_type = row.target_component_type;
        const relationship = row.relationship;

        // Prepare data for CSV file
        extractedComponentData.push({
            source_component: source,
            target_component: target,
            relationship: relationship
        });
    });

    // Create and write the CSV file
    const newCsvFileName = fileName.replace('_EDMM.csv', '_GraphAnalysis.csv');
    writeDataToCSV(extractedComponentData, newCsvFileName, () => {
        // UploadCSV file to MinIO
        uploadCSVToMinIO(newCsvFileName, originalMsgContent, architectureName);
    });
}

// Write extracted data to the first CSV file
function writeDataToCSV(data, csvFileName, callback) {
    const csvWriter = createObjectCsvWriter({
        path: csvFileName,
        header: [
            { id: 'source_component', title: 'source_component' },
            { id: 'target_component', title: 'target_component' },
            { id: 'relationship', title: 'relationship' }
        ]
    });

    csvWriter.writeRecords(data)
        .then(() => {
            console.log(" [x] Final CSV file '%s' written successfully", csvFileName);
            callback();
        })
        .catch(err => {
            console.error(" [!] Error writing final CSV file '%s' :", csvFileName, err);
        });
}

// Upload extended CSV file to MinIO and save to MySQL
function uploadCSVToMinIO(csvFileName1, originalMsgContent, architectureName) {
    fs.readFile(csvFileName1, (err, data) => {
        if (err) {
            console.error(" [!] Error reading extended CSV file:", err);
            return;
        }

        minioClient.putObject('architectures', csvFileName1, data, function (err, etag) {
            if (err) {
                console.error(' [!] Error uploading extended CSV to MinIO:', err);
                return;
            }
            console.log(' [x] Extended CSV file uploaded successfully to MinIO');
            fs.unlinkSync(csvFileName1); // Delete local file after upload


            // Save extended CSV file name and metadata to MySQL database
            saveGraphFileNameToMySQL(csvFileName1, architectureName, () => {
                let updatedMessageContent = JSON.parse(originalMsgContent);
                // Add the basket file name in the message
                updatedMessageContent.graphfile = csvFileName1;
                const updatedMsgContentStr = JSON.stringify(updatedMessageContent);
                // Send the updated message to the output queue
                rabbitMQChannel.sendToQueue(outputQueue, Buffer.from(updatedMsgContentStr));
                console.log(" [x] Message sent to '%s' queue", outputQueue);
            });
        });
    });
}

// Function to save the Graph CSV file name and metadata to MySQL database
function saveGraphFileNameToMySQL(csvFileName, architectureName, callback) {
    // First, fetch the architecture ID, user, name, architecture type, analysisflas
    const fetchSql = `SELECT architectureid, user, nameofarchitecture, architecturetype, analysis FROM UnifileArchitectures WHERE nameofarchitecture = ?`;
    const fetchValues = [architectureName];

    con.query(fetchSql, fetchValues, (err, results) => {
        if (err) {
            console.error(" [!] Error fetching data from Architectures table:", err);
            return;
        }

        if (results.length === 0) {
            console.error(" [!] No matching architecture found in Architectures table");
            return;
        }

        const { architectureid, user, nameofarchitecture, architecturetype, analysis } = results[0];

        // Insert data into 1on1Architectures table
        const insertSql = `INSERT INTO GraphArchitectures (architectureid, user, nameofarchitecture, architecturetype, graphfile, analysis) VALUES (?, ?, ?, ?, ?, ?)`;
        const values = [architectureid, user, nameofarchitecture, architecturetype, csvFileName, analysis];

        con.query(insertSql, values, (err, result) => {
            if (err) {
                console.error(" [!] Error inserting data into 'GraphArchitectures table' :", err);
                return;
            }
            console.log(" [x] Data inserted into 'GraphArchitectures' table successfully");
            callback();
        });
    });
}