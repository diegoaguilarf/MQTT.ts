import { assertEquals } from 'https://deno.land/std/testing/asserts.ts';
import { BaseClient } from './base.ts';
import { encode, decode, AnyPacket, PublishPacket } from '../packets/mod.ts';

class TestClient extends BaseClient {
  sentPackets: AnyPacket[] = [];
  receivedPackets: AnyPacket[] = [];
  timerCallbacks: { [key: string]: Function } = {};

  // These methods must be overridden by BaseClient subclasses:

  async open() {}

  async startReading() {}

  async write(bytes: Uint8Array) {
    const packet = decode(bytes);
    this.sentPackets.push(packet!);
  }

  async close() {
    this.connectionClosed();
  }

  // Helper method to simulate receiving bytes for a packet from the server.
  receivePacket(packet: AnyPacket, options: { trickle?: boolean } = {}) {
    this.receiveBytes(encode(packet));
  }

  // Gives us access to the protected `bytesReceived` method.
  receiveBytes(bytes: Uint8Array, options: { trickle?: boolean } = {}) {
    if (options.trickle) {
      for (let i = 0; i < bytes.length; i++) {
        this.bytesReceived(bytes.slice(i, i + 1));
      }
    } else {
      this.bytesReceived(bytes);
    }
  }

  // Capture packets received after decoded by the client.
  packetReceived(packet: AnyPacket) {
    this.receivedPackets.push(packet);

    // Let the base client process the packet.
    super.packetReceived(packet);
  }

  // These methods are here to simulate timers without actually passing time:

  startTimer(name: string, cb: (...args: unknown[]) => void, _delay: number) {
    this.timerCallbacks[name] = cb;
  }

  stopTimer(_name: string) {}

  timerExists(name: string) {
    return !!this.timerCallbacks[name];
  }

  triggerTimer(name: string) {
    this.timerCallbacks[name]();
  }

  protected log(msg: string, ...args: unknown[]) {
    // console.log(msg, ...args);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(() => resolve(), ms));
}

Deno.test('connect/disconnect', async () => {
  const client = new TestClient();

  client.connect();

  assertEquals(client.connectionState, 'connecting');

  // Sleep a little to allow the connect packet to be sent.
  await sleep(1);

  assertEquals(client.sentPackets[0].type, 'connect');
  assertEquals(client.connectionState, 'waiting-for-connack');

  client.receivePacket({
    type: 'connack',
    returnCode: 0,
    sessionPresent: false,
  });

  assertEquals(client.connectionState, 'connected');

  client.disconnect();

  assertEquals(client.connectionState, 'disconnecting');

  // Sleep a little to allow the disconnect packet to be sent.
  await sleep(1);

  assertEquals(client.sentPackets[1].type, 'disconnect');
  assertEquals(client.connectionState, 'disconnected');
});

Deno.test('open throws', async () => {
  const client = new TestClient();

  client.open = async () => {
    throw new Error('nope');
  };

  client.connect();

  assertEquals(client.connectionState, 'connecting');

  // Sleep a little to allow the connect packet to be sent.
  await sleep(1);

  assertEquals(client.connectionState, 'connect-failed');

  // No connect packet should have been written.
  assertEquals(client.sentPackets.length, 0);

  // Calling disconnect in the connect-failed state is a no-op
  // and transitions directly to the disconnected state.
  client.disconnect();

  assertEquals(client.connectionState, 'disconnected');

  // Sleep long enough for the disconnect packet to have been written.
  await sleep(1);

  // But no disconnect packet should have been written.
  assertEquals(client.sentPackets.length, 0);
});

Deno.test('waiting for connack times out', async () => {
  const client = new TestClient({ connectTimeout: 5 });

  client.connect();

  assertEquals(client.connectionState, 'connecting');

  // Sleep a little to allow the connect packet to be sent.
  await sleep(1);

  // Now we see the connect packet was written.
  assertEquals(client.sentPackets[0].type, 'connect');

  // And we are waiting for a connack packet.
  assertEquals(client.connectionState, 'waiting-for-connack');

  // This is when we should receive the connack packet.
  // Simulate time passing by manually triggering the connect timer.
  client.triggerTimer('connect');

  assertEquals(client.connectionState, 'connect-failed');

  // Calling disconnect in the connect-failed state is a no-op
  // and transitions directly to the disconnected state.
  client.disconnect();

  assertEquals(client.connectionState, 'disconnected');

  // Sleep long enough for the disconnect packet to have been written.
  await sleep(1);

  // But no disconnect packet should have been written.
  assertEquals(client.sentPackets.length, 1);
});

Deno.test('client can receive one byte at a time', async () => {
  const client = new TestClient();

  client.connect();

  assertEquals(client.connectionState, 'connecting');

  // Sleep a little to allow the connect packet to be sent.
  await sleep(1);

  assertEquals(client.sentPackets[0].type, 'connect');
  assertEquals(client.connectionState, 'waiting-for-connack');

  client.receivePacket(
    {
      type: 'connack',
      returnCode: 0,
      sessionPresent: false,
    },
    { trickle: true }
  );

  assertEquals(client.receivedPackets[0].type, 'connack');
  assertEquals(client.connectionState, 'connected');

  client.receivePacket(
    {
      type: 'publish',
      topic: 'test',
      payload: 'test',
    },
    { trickle: true }
  );

  assertEquals(client.receivedPackets[1].type, 'publish');

  const bytes = encode({
    type: 'publish',
    topic: 'test2',
    payload: 'test2',
  });

  // Receive all but the last byte:
  client.receiveBytes(bytes.slice(0, bytes.length - 1));
  // No new packets have been received:
  assertEquals(client.receivedPackets.length, 2);
  // Send the last byte:
  client.receiveBytes(bytes.slice(bytes.length - 1));
  // A new packet has been received:
  assertEquals(client.receivedPackets.length, 3);
  assertEquals(client.receivedPackets[2].type, 'publish');
});

Deno.test('client can receive bytes for multiple packets at once', async () => {
  const client = new TestClient();

  client.connect();

  assertEquals(client.connectionState, 'connecting');

  // Sleep a little to allow the connect packet to be sent.
  await sleep(1);

  assertEquals(client.sentPackets[0].type, 'connect');
  assertEquals(client.connectionState, 'waiting-for-connack');

  client.receivePacket({
    type: 'connack',
    returnCode: 0,
    sessionPresent: false,
  });

  assertEquals(client.receivedPackets[0].type, 'connack');
  assertEquals(client.connectionState, 'connected');

  const bytes = Uint8Array.from([
    ...encode({
      type: 'publish',
      topic: 'topic1',
      payload: 'payload1',
    }),
    ...encode({
      type: 'publish',
      topic: 'topic2',
      payload: 'payload2',
    }),
  ]);

  client.receiveBytes(bytes);
  console.log(client.receivedPackets);

  assertEquals(client.receivedPackets.length, 3);
  assertEquals(client.receivedPackets[1].type, 'publish');
  assertEquals((client.receivedPackets[1] as PublishPacket).topic, 'topic1');
  assertEquals(client.receivedPackets[2].type, 'publish');
  assertEquals((client.receivedPackets[2] as PublishPacket).topic, 'topic2');
});
