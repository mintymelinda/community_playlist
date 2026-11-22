import test from 'node:test';
import assert from 'node:assert/strict';
import { SerialExecutor } from '../src/lib/serial.js';

test('serializes operations and continues after a rejected operation', async () => {
  const serial = new SerialExecutor();
  const order = [];
  const first = serial.run(async () => {
    await new Promise(resolve => setTimeout(resolve, 10));
    order.push('first');
  });
  const second = serial.run(async () => {
    order.push('second');
    throw new Error('expected');
  });
  const third = serial.run(async () => order.push('third'));
  await first;
  await assert.rejects(second, /expected/);
  await third;
  assert.deepEqual(order, ['first', 'second', 'third']);
});
