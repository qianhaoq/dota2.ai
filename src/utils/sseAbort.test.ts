import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { createSseAbort } from '../../lib/sseAbort.js';

type MockRes = EventEmitter & { writableEnded: boolean };

function makeReqRes({ writableEnded = false } = {}) {
  const req = new EventEmitter();
  const res = new EventEmitter() as MockRes;
  res.writableEnded = writableEnded;
  return { req, res };
}

describe('createSseAbort', () => {
  it('aborts the shared signal when the client disconnects mid-response (res close, response unfinished)', () => {
    const { req, res } = makeReqRes();
    const sse = createSseAbort(req, res);

    expect(sse.aborted()).toBe(false);
    res.emit('close');
    expect(sse.aborted()).toBe(true);
    expect(sse.signal.aborted).toBe(true);
  });

  it('does NOT abort when res closes after a fully written response', () => {
    // res 'close' also fires after a normal, complete response — writableEnded
    // distinguishes that from a client disconnect.
    const { req, res } = makeReqRes({ writableEnded: true });
    const sse = createSseAbort(req, res);

    res.emit('close');
    expect(sse.aborted()).toBe(false);
  });

  it('aborts on the legacy req "aborted" event', () => {
    const { req, res } = makeReqRes();
    const sse = createSseAbort(req, res);

    req.emit('aborted');
    expect(sse.aborted()).toBe(true);
  });

  it('aborts with an AbortError reason so fetch/SDK calls reject cleanly', () => {
    const { req, res } = makeReqRes();
    const sse = createSseAbort(req, res);

    res.emit('close');
    expect((sse.signal.reason as Error)?.name).toBe('AbortError');
  });

  it('detach() removes both listeners — late events no longer abort', () => {
    const { req, res } = makeReqRes();
    const sse = createSseAbort(req, res);

    sse.detach();
    res.emit('close');
    req.emit('aborted');

    expect(sse.aborted()).toBe(false);
    expect(res.listenerCount('close')).toBe(0);
    expect(req.listenerCount('aborted')).toBe(0);
  });

  it('marks writableEnded responses again: abort fires only while the response is still being written', () => {
    const { req, res } = makeReqRes();
    const sse = createSseAbort(req, res);

    res.writableEnded = true;
    res.emit('close'); // normal completion
    expect(sse.aborted()).toBe(false);

    res.writableEnded = false;
    res.emit('close'); // a second response attempt that really lost the client
    expect(sse.aborted()).toBe(true);
  });
});
