#!/usr/bin/env node

const amqp = require('amqplib/callback_api');
const mqtt = require("mqtt");
const Minio = require('minio');
const xml2js = require('xml2js');
const { createObjectCsvWriter } = require('csv-writer');
const fs = require('fs');
const mysql = require('mysql2');

// behaviour parameter
const prefetch_count = 3

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
const mqttClient = mqtt.connect(`mqtt://${mqttconnection}`, {
    username: mqttuser,
    password: mqttpassword
});

// RabbitMQ input queue
const inputQueue = 'toscaXML';
// Mosquitto output topic
const outputTopic = 'unifiedArchitectures';

// Function to create the 'UnifileArchitectures' table if it doesn't exist
function createUnifileTableIfNotExists(callback) {
    const sql = `
        CREATE TABLE IF NOT EXISTS UnifileArchitectures (
            architectureid INT NOT NULL,
            user VARCHAR(255) NOT NULL,
            nameofarchitecture VARCHAR(255) NOT NULL,
            architecturetype VARCHAR(255) NOT NULL,
            unifile VARCHAR(255) NOT NULL,
            analysis INT NOT NULL,
            timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=latin1;
    `;

    con.query(sql, (err) => {
        if (err) {
            console.error(' [!] Error creating table:', err);
            callback(err);
        } else {
            console.log(' [i] Table UnifileArchitectures is ready.');
            callback(null);
        }
    });
}

// Connect to Mosquitto
mqttClient.on('connect', function() {
    console.log(` [i] Client connected to Mosquitto: ${mqttClient.connected}`);
}).on('error', function(error) {
    console.error(' [!] Error connecting to Mosquitto:', error.message);
    setTimeout(() => {
        mqttClient.reconnect();
    }, 5000);
});

// Connect to RabbitMQ and process messages
amqp.connect(`amqp://${amqpuser}:${amqppassword}@${amqpconnection}`, function (error0, connection) {
    if (error0) {
        throw error0;
    }

    connection.createChannel(function (error1, channel) {
        if (error1) {
            throw error1;
        }

        // Set up queues
        channel.assertQueue(inputQueue, { durable: false });

        // Set the prefetch count
        channel.prefetch(prefetch_count);

        console.log(" [*] Waiting for messages in %s ...", inputQueue);

        // Create table if it doesn't exist
        createUnifileTableIfNotExists((err) => {
            if (err) {
                console.error(' [!] Exiting due to table creation error.');
                con.end();
                channel.close();
                connection.close();
                process.exit(1);
                return;
            }

            channel.consume(inputQueue, function (msg) {
                const content = msg.content.toString();
                console.log(" ------------------------")
                console.log(" [x] Received new message");
                console.log(" [x] Content: %s", content);

                try {
                    const jsonMessage = JSON.parse(content);
                    const fileName = jsonMessage.origfile;
                    const architectureName = jsonMessage.nameofarchitecture;
                    const origFormat = jsonMessage.orig_format
                    fetchFileFromMinIO(channel, fileName, architectureName, origFormat, content, msg); // Pass msg for acknowledgment
                } catch (e) {
                    console.error(" [!] Failed to parse JSON: %s", content);
                    channel.ack(msg); // Acknowledge the message if parsing fails
                }
            }, { noAck: false }); // Set noAck to false to handle messages one by one
        });
    });
});

// Fetch file from MinIO and analyze it
function fetchFileFromMinIO(channel, fileName, architectureName, origFormat, originalMsgContent, originalMsg) {
    minioClient.getObject('architectures', fileName, function (err, dataStream) {
        if (err) {
            console.error(" [!] Error fetching file from MinIO: '%s'", fileName, err);
            channel.ack(originalMsg); // Acknowledge the message on error
            return;
        }

        let fileContent = '';
        dataStream.on('data', function (chunk) {
            fileContent += chunk;
        });

        dataStream.on('end', function () {
            console.log(" [x] File downloaded from MinIO: '%s'", fileName);
            parseArchitectureXML(channel, fileContent, fileName, architectureName, origFormat, originalMsgContent, originalMsg); // Pass msg for acknowledgment
        });

        dataStream.on('error', function (err) {
            console.error(" [!] Error reading file stream: '%s'", fileName, err);
            channel.ack(originalMsg); // Acknowledge the message on stream error
        });
    });
}

// Parse XML data and extract information
function parseArchitectureXML(channel, xmlContent, fileName, architectureName, origFormat, originalMsgContent, originalMsg) {
    const parser = new xml2js.Parser();

    parser.parseString(xmlContent, (err, result) => {
        if (err) {
            console.error(" [!] Error parsing XML data: '%s'", fileName, err);
            channel.ack(originalMsg); // Acknowledge the message on parse error
            return;
        }

        const architecture = result.Definitions.ServiceTemplate[0];
        const topology = architecture.TopologyTemplate[0];
        const nodeTemplates = topology.NodeTemplate || [];
        const relationshipTemplates = topology.RelationshipTemplate || [];

        const extractedData = [];

        relationshipTemplates.forEach(rel => {
            const sourceId = rel.SourceElement[0].$.ref;
            const targetId = rel.TargetElement[0].$.ref;

            const sourceNode = nodeTemplates.find(node => node.$.id === sourceId);
            const targetNode = nodeTemplates.find(node => node.$.id === targetId);

            if (sourceNode && targetNode) {
                extractedData.push({
                    source_component: sourceNode.$.name,
                    source_component_type: sourceNode.$.type.split(':')[1],
                    target_component: targetNode.$.name,
                    target_component_type: targetNode.$.type.split(':')[1],
                    relationship: rel.$.type.split(':')[1]
                                            .replace(/^([A-Z])/, match => match.toLowerCase())
                                            .replace(/([A-Z])/g, '_$&').toLowerCase(), // e.g. ToscaBaseTypes:HostedOn --> hosted_on
                    relationship_type: rel.$.type.split(':')[1]
                                                    .replace(/^([A-Z])/, match => match.toLowerCase())
                                                    .replace(/([A-Z])/g, '_$&').toLowerCase() 
                                                    === 'hosted_on' ? 'hosting' : 'connection',
                    orig_format: origFormat,
                    architecture_name: architectureName
                });
            }
        });

        const csvFileName = fileName.replace('.xml', '_EDMM.csv');
        writeDataToCSV(extractedData, csvFileName, () => {
            uploadCSVToMinIO(csvFileName, channel, originalMsgContent, architectureName, origFormat, originalMsg); // Pass msg for acknowledgment
        });
    });
}

// Write data to CSV file
function writeDataToCSV(data, csvFileName, callback) {
    const csvWriter = createObjectCsvWriter({
        path: csvFileName,
        header: [
            { id: 'source_component', title: 'source_component' },
            { id: 'source_component_type', title: 'source_component_type' },
            { id: 'target_component', title: 'target_component' },
            { id: 'target_component_type', title: 'target_component_type' },
            { id: 'relationship', title: 'relationship' },
            { id: 'relationship_type', title: 'relationship_type' },
            { id: 'orig_format', title: 'orig_format' },
            { id: 'architecture_name', title: 'architecture_name' }
        ]
    });

    csvWriter.writeRecords(data)
        .then(() => {
            console.log(" [x] CSV file '%s' written successfully", csvFileName);
            callback();
        })
        .catch(err => {
            console.error(' [!] Error writing CSV file: ', err);
        });
}

// Upload CSV file to MinIO and save to MySQL
function uploadCSVToMinIO(csvFileName, channel, originalMsgContent, architectureName, origFormat, originalMsg) {
    fs.readFile(csvFileName, (err, data) => {
        if (err) {
            console.error(" [!] Error reading CSV file: %s ", csvFileName, err);
            channel.ack(originalMsg); // Acknowledge the message on read error
            return;
        }

        minioClient.putObject('architectures', csvFileName, data, function (err, etag) {
            if (err) {
                console.error(` [!] Error uploading CSV file '%s' to MinIO`, csvFileName, err);
                channel.ack(originalMsg); // Acknowledge the message on upload error
                return;
            }
            console.log(` [x] CSV file uploaded successfully to MinIO: ${csvFileName}`);
            fs.unlinkSync(csvFileName); // Delete local file after upload

            // Save CSV file name and metadata to MySQL database
            saveCSVFileNameToMySQL(csvFileName, architectureName, origFormat, () => {
                let updatedMessageContent = JSON.parse(originalMsgContent);
                // add the unifile name in the message
                updatedMessageContent.unifile = csvFileName;
                const updatedMsgContentStr = JSON.stringify(updatedMessageContent);          
                // Publish the updated message to the output topic
                mqttClient.publish(outputTopic, updatedMsgContentStr);
                console.log(" [x] Message with unifile published to output topic '%s'", outputTopic);
                
                // Acknowledge the original message after processing
                channel.ack(originalMsg);
            });
        });
    });
}

// Function to save the CSV file name and metadata to MySQL database
function saveCSVFileNameToMySQL(csvFileName, architectureName, origFormat, callback) {
    // First, fetch the architecture ID, user, nameofarchitecture, analysisflag from the Architectures table
    const fetchSql = `SELECT architectureid, user, nameofarchitecture, analysis FROM OriginalArchitectures WHERE nameofarchitecture = ?`;
    
    con.query(fetchSql, [architectureName], (err, results) => {
        if (err) {
            console.error(" [!] Error fetching data from Architectures table:", err);
            return;
        }

        if (results.length === 0) {
            console.error(" [!] No matching architecture found in Architectures table");
            return;
        }

        const { architectureid, user, nameofarchitecture, analysis } = results[0];
        
        // Insert data into UnifileArchitectures table
        const insertSql = `INSERT INTO UnifileArchitectures (architectureid, user, nameofarchitecture, architecturetype, unifile, analysis) VALUES (?, ?, ?, ?, ?, ?)`;
        const values = [architectureid, user, nameofarchitecture, origFormat, csvFileName, analysis];

        con.query(insertSql, values, (err, result) => {
            if (err) {
                console.error(" [!] Error inserting data into 'UnifileArchitectures' table :", err);
                return;
            }
            console.log(" [x] Data inserted into 'UnifileArchitectures' table successfully");
            callback();
        });
    });
}
