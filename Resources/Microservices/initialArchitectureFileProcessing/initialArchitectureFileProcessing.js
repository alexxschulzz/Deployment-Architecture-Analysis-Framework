#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const Minio = require('minio');
const mysql = require('mysql2');
const amqp = require('amqplib/callback_api');
const async = require('async');

// behaviour parameter
const parallel_uploads = 10

// RabbitMQ connection
const amqpconnection = process.env.RABBITMQCONNECTION
const amqpuser = "user"
const amqppassword = "password"

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

const minioInputClienthostname = process.env.MINIOINPUTCONNECTION
const minioInputClientaccessKey = "user"
const minioInputClientsecretKey = "password"

const minioInputClient = new Minio.Client({
    endPoint: minioInputClienthostname,
    port: 9000,
    useSSL: false,
    accessKey: minioInputClientaccessKey,
    secretKey: minioInputClientsecretKey
});

const inputBuckets = [
    { name: "training", analysisFlag: 0 },
    { name: "analysis", analysisFlag: 1 }
];
const bucketName = "architectures";
const queueName = 'architectureFilesInput';

// Store processed filenames to avoid re-processing
const processedFiles = new Set();

// Asynchronous queue for processing files with a concurrency limit
const uploadQueue = async.queue((task, callback) => {
    processFile(task.channel, task.file, task.analysisFlag, callback);
}, parallel_uploads); // number of parallel uploads

uploadQueue.drain(() => {
    console.log(' [x] All files were processed');
});

// Function to create the 'OriginalArchitectures' table if it doesn't exist
function createTableIfNotExists(callback) {
    const sql = `
        CREATE TABLE IF NOT EXISTS OriginalArchitectures (
            architectureid INT AUTO_INCREMENT PRIMARY KEY,
            user VARCHAR(255) NOT NULL,
            nameofarchitecture VARCHAR(255) NOT NULL,
            origfile VARCHAR(255) NOT NULL,
            analysis INT NOT NULL,
            timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=latin1;
    `;

    con.query(sql, (err) => {
        if (err) {
            console.error(' [!] Error creating table:', err);
            callback(err);
        } else {
            console.log(' [i] Table OriginalArchitectures is ready.');
            callback(null);
        }
    });
}

// functions whih checks if the input buckets exists, if not the buckets are created
function ensureInputBucketsExist(callback) {
    let pending = inputBuckets.length; // number of buckets

    inputBuckets.forEach(({ name: bucketName }) => {
        minioInputClient.bucketExists(bucketName, (err, exists) => {
            if (err) {
                console.error(` [!] Error checking bucket existence (${bucketName}):`, err);
                return callback(err);
            }

            if (exists) {
                console.log(` [i] Bucket ${bucketName} already exists.`);
            } else {
                minioInputClient.makeBucket(bucketName, 'eu-central-1', (err) => {
                    if (err) {
                        console.error(` [!] Error creating bucket (${bucketName}):`, err);
                        return callback(err);
                    }
                    console.log(` [i] Bucket ${bucketName} created successfully.`);
                });
            }

            // track progress
            pending -= 1;
            if (pending === 0) {
                callback(null); // all buckets were checked/created
            }
        });
    });
}

// function which process the files in the input bucket and monitors if new files were added which need to be processed
function readAndProcessFiles(channel) {
    inputBuckets.forEach(({ name: bucketName, analysisFlag }) => {
        // list all files in the bucket
        minioInputClient.listObjects(bucketName, '', true)
            .on('data', (obj) => {
                const file = obj.name;
                if (!processedFiles.has(file)) { // check if file was already processed
                    processedFiles.add(file); // mark file as processed
                    uploadQueue.push({ file, channel, analysisFlag }); // add file to upload queue
                }
                else {
                    console.log(` [!] File ${file} has already been processed.`);
                }
            })
            .on('error', (err) => {
                console.error(` [!] Error listing objects in bucket (${bucketName}):`, err);
            });

        // monitor bucket to check if new files were added
        minioInputClient.listenBucketNotification(bucketName, '', '', ['s3:ObjectCreated:*'])
            .on('notification', (record) => {
                const file = record.s3.object.key;
                if (!processedFiles.has(file)) { // check if file was already processed
                    processedFiles.add(file); // mark file as processed
                    uploadQueue.push({ file, channel, analysisFlag }); // add file to upload queue
                }
                else {
                    console.log(` [i] File ${file} has already been processed.`);
                }
            })
            .on('error', (err) => {
                console.error(` [!] Error setting up bucket notification (${bucketName}):`, err);
            });
    });
}

// RabbitMQ connection
amqp.connect(`amqp://${amqpuser}:${amqppassword}@${amqpconnection}`, (err, connection) => {
    if (err) {
        throw err;
    }

    connection.createChannel((err, channel) => {
        if (err) {
            throw err;
        }

        channel.assertQueue(queueName, {
            durable: false
        });

        ensureInputBucketsExist((err) => {
            if (err) {
                console.error(" [!] Failed to ensure buckets exist. Exiting...");
                process.exit(1);
            }
        
            console.log(" [i] All required buckets are ready.");

            // Check if the main framework MinIO bucket exists and create it if not
            minioClient.bucketExists(bucketName, (err, exists) => {
                if (err) {
                    return console.log(' [!] Error checking bucket existence.', err);
                }

                if (exists) {
                    console.log(` [i] Bucket ${bucketName} already exists.`);
                    // Create table and then read files
                    createTableIfNotExists((err) => {
                        if (!err) {
                            readAndProcessFiles(channel); // Call to read and process files
                        }
                    });
                } else {
                    // create bucket
                    minioClient.makeBucket(bucketName, 'eu-central-1', (err) => {
                        if (err) {
                            return console.log(' [!] Error creating bucket.', err);
                        }
                        console.log(` [i] Bucket ${bucketName} created successfully.`);

                        // Create table and then read files
                        createTableIfNotExists((err) => {
                            if (!err) {
                                readAndProcessFiles(channel); // Call to read and process files
                            }
                        });
                    });
                }
            });
        });
    });
});

// Function to check if an architecture already exists in the database
function checkIfArchitectureExists(fileName, callback) {
    const sql = 'SELECT COUNT(*) AS count FROM OriginalArchitectures WHERE origfile = ?';
    con.query(sql, [fileName], (err, results) => {
        if (err) {
            console.error(' [!] Error checking database:', err);
            callback(err, null);
        } else {
            const count = results[0].count;
            callback(null, count > 0);
        }
    });
}

function processFile(channel, file, analysisFlag, callback) {
    const sourceBucket = inputBuckets.find(bucket => bucket.analysisFlag === analysisFlag).name;
    const fileNameWithoutExtension = path.basename(file, path.extname(file));

    checkIfArchitectureExists(file, (err, exists) => {
        if (err) {
            console.error(' [!] Skipping file due to database error:', file);
            return callback(err);
        }

        if (exists) {
            console.log(` [!] Architecture ${file} already exists in the database. Skipping upload.`);
            return callback();
        } else {
            // download the file from the MinIO inputBucket
            // minioInputClient.fGetObject(sourceBucket, file, `/tmp/${file}`, (err) => {

            // stream file from MinIO inputBucekts to architectures bucket
            minioInputClient.getObject(sourceBucket, file, (err, stream) => {
                if (err) {
                    console.error(` [!] Error reading file ${file} from MinIO bucket (${sourceBucket}):`, err);
                    return callback(err);
                }

                console.log(` [x] File ${file} downloaded successfully from ${sourceBucket} bucket.`);

                // upload the file into the architectures bucket
                // minioClient.fPutObject(bucketName, file, `/tmp/${file}`, (err) => {
                
                // stream the file into the architectures bucket
                minioClient.putObject(bucketName, file, stream, (err) => {
                    if (err) {
                        console.error(` [!] Error uploading file ${file} to MinIO bucket (${bucketName}):`, err);
                        return callback(err);
                    }

                    console.log(` [x] File ${file} uploaded successfully to ${bucketName} bucket.`);

                    // save metadata into database
                    const sql = `INSERT INTO OriginalArchitectures (user, nameofarchitecture, origfile, analysis) VALUES (?, ?, ?, ?)`;
                    const values = [
                        'defaultUser',          // for now only defaultUser
                        fileNameWithoutExtension,
                        file,
                        analysisFlag
                    ];

                    con.query(sql, values, (err) => {
                        if (err) {
                            console.error(' [!] Error inserting data into database:', err);
                            return callback(err);
                        } else {
                            console.log(` [x] File ${file} metadata stored successfully.`);

                            // send message into RabbitMQ queue
                            const message = JSON.stringify({
                                nameofarchitecture: fileNameWithoutExtension,
                                origfile: file,
                                analysis: analysisFlag
                            });

                            channel.sendToQueue(queueName, Buffer.from(message));
                            console.log(` [x] Message sent to queue: ${message}`);
                            return callback();
                        }
                    });
                });
            });
        }
    });
}
