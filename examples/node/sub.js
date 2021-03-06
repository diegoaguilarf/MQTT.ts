#!/usr/bin/env node

// const { Client } = require('@jdiamond/mqtt');
const { Client } = require('../../build/node.js');

async function main() {
  const client = new Client({
    url: 'mqtt://localhost',
  });

  await client.connect();

  client.on('message', (topic, payload) => {
    console.log(topic, payload.toString('utf-8'));
  });

  await client.subscribe('#');
}

main();
