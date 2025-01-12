#!/usr/bin/env node

const amqp = require('amqplib/callback_api');
const Minio = require('minio');
const fs = require('fs');
const yaml = require('js-yaml');

// behaviour parameter
const prefetch_count = 3

// Load YAML configuration
const config = yaml.load(fs.readFileSync('./architectureFileRouterConfig.yaml', 'utf8'));

// RabbitMQ connection
const amqpconnection = process.env.RABBITMQCONNECTION
const amqpuser = "user"
const amqppassword = "password"

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

const inputQueue = 'architectureFilesInput';

// RabbitMQ connection
amqp.connect(`amqp://${amqpuser}:${amqppassword}@${amqpconnection}`, function (error0, connection) {
    if (error0) {
        throw error0;
    }

    connection.createChannel(function (error1, channel) {
        if (error1) {
            throw error1;
        }

        channel.assertQueue(inputQueue, { durable: false });
        // Setup queues based on configuration
        config.routes.forEach(route => {
            channel.assertQueue(route.queue, { durable: false });
        });
        channel.assertQueue(config.defaultQueue, { durable: false });

        channel.prefetch(prefetch_count);

        console.log(" [*] Waiting for messages in input queue ...");
        channel.consume('architectureFilesInput', function (msg) {
            handleIncomingMessage(channel, msg);
        }, { noAck: false });
    });
});

// Handle incoming messages
function handleIncomingMessage(channel, msg) {
    const content = msg.content.toString();
    console.log(" ------------------------");
    console.log(" [x] Received new message");
    console.log(" [x] Content: %s", content);
    try {
        const jsonMessage = JSON.parse(content);
        const fileName = jsonMessage.origfile;
        fetchFileFromMinIO(channel, fileName, msg);
    } catch (e) {
        console.error(" [!] Failed to parse JSON: %s", content);
        channel.sendToQueue(config.defaultQueue, Buffer.from(content));
        channel.ack(msg);
    }
}

// Fetch the file from MinIO and process it
function fetchFileFromMinIO(channel, fileName, originalMsg) {
    minioClient.getObject('architectures', fileName, function (err, dataStream) {
        if (err) {
            console.error(" [!] Error fetching file from MinIO: ", err);
            channel.sendToQueue(config.defaultQueue, Buffer.from(originalMsg.content));
            channel.ack(originalMsg);
            return;
        }

        let fileContent = '';
        dataStream.on('data', function (chunk) {
            fileContent += chunk;
        });

        dataStream.on('end', function () {
            console.log(" [x] File downloaded from MinIO: '%s'", fileName);
            routeFileContent(channel, fileContent, originalMsg);
        });

        dataStream.on('error', function (err) {
            console.error(" [!] Error reading file stream: ", err);
            channel.sendToQueue(config.defaultQueue, Buffer.from(originalMsg.content));
            channel.ack(originalMsg);
        });
    });
}

// Route the file based on content using the YAML configuration
function routeFileContent(channel, fileContent, originalMsg) {
    let routed = false;
    config.routes.forEach(route => {
        if (Array.isArray(route.pattern)) {
            // Multiple patterns to match
            const matchesAll = route.pattern.every(p => fileContent.includes(p));
            if (matchesAll) {
                sendToQueue(channel, route, originalMsg);
                routed = true;
            }
        } else {
            // Single pattern to match
            if (fileContent.includes(route.pattern)) {
                sendToQueue(channel, route, originalMsg);
                routed = true;
            }
        }
    });

    // If no pattern matches, route to the default queue (e.g., garbage collector)
    if (!routed) {
        channel.sendToQueue(config.defaultQueue, Buffer.from(originalMsg.content));
        console.log(" [!] Format not recognized, routed to garbageCollector");
    }

    channel.ack(originalMsg);
}

// Send the processed message to the appropriate queue based on the configuration
function sendToQueue(channel, route, originalMsg) {
    let updatedMessageContent = JSON.parse(originalMsg.content);
    updatedMessageContent.orig_format = route.format;
    const updatedMsgContentStr = JSON.stringify(updatedMessageContent);
    channel.sendToQueue(route.queue, Buffer.from(updatedMsgContentStr));
    console.log(` [x] Format detected: '${route.queue}'`);
    console.log(` [x] Routed message to '${route.queue}' queue`);
}
