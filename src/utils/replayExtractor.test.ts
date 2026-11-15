import {it,expect} from 'vitest';
import {runExtractor,sanitizeExtractorDiagnostic} from '../../lib/matchReview/replayIngest/extractor.js';
const run=(program:string)=>runExtractor(process.execPath,['-e',program],new AbortController().signal);
it('retains redacted structured failures and exit status',async()=>{
 const error=await run(`console.error('/tmp/replay-worker-xyz/replay.dem');console.log(JSON.stringify({ok:false,error:'demo_truncated /tmp/private https://example.com/replay?token=secret'}));process.exitCode=2;`).catch(e=>e);
 expect(error.message).toBe('extractor_failed');
 expect(error.diagnostics).toMatchObject({extractor_exit:2,extractor_signal:null,extractor_ok:false,extractor_stderr:'<path>\n'});
 expect(error.diagnostics.extractor_error).toBe('demo_truncated <path> <url>');
});
it('caps stderr at 2048 characters',async()=>{
 const error=await run("process.stderr.write('x'.repeat(10000));process.exitCode=2;").catch(e=>e);
 expect(error.diagnostics.extractor_stderr).toHaveLength(2048);
 expect(error.diagnostics.extractor_stderr_truncated).toBe(true);
});
it('records signal termination',async()=>{
 const error=await run("process.kill(process.pid,'SIGKILL');").catch(e=>e);
 expect(error.message).toBe('extractor_failed');
 expect(error.diagnostics).toMatchObject({extractor_exit:null,extractor_signal:'SIGKILL'});
});
it('preserves successful JSON results',async()=>{
 const result={ok:true,format:'zstd',bytes:32,sha256:'abc'};
 await expect(run(`console.log('${JSON.stringify(result)}')`)).resolves.toEqual(result);
});
it('normalizes invalid JSON and redacts its tail',async()=>{
 const error=await run("console.log('invalid /tmp/private');").catch(e=>e);
 expect(error.message).toBe('extractor_failed');
 expect(error.diagnostics.extractor_stdout_tail).toBe('invalid <path>');
});
it('preserves the stdout limit failure',async()=>{
 const error=await run("process.stdout.write('x'.repeat(70000));").catch(e=>e);
 expect(error.message).toBe('extractor_output_limit');
 expect(error.diagnostics).toHaveProperty('extractor_exit');
});
it('attaches diagnostics on spawn failure and abort',async()=>{
 const error=await runExtractor('/nonexistent/extractor',[],new AbortController().signal).catch(e=>e);
 expect(error.message).toBe('extractor_failed');
 expect(error.diagnostics).toHaveProperty('extractor_signal',null);
 const controller=new AbortController();
 const pending=runExtractor(process.execPath,['-e','setInterval(()=>{},1000)'],controller.signal);
 controller.abort();
 const aborted=await pending.catch(e=>e);
 expect(aborted.diagnostics).toHaveProperty('extractor_exit');
 expect(aborted.message).toMatch(/aborted|extractor_failed/i);
});
it('keeps an abort reason such as stage_timeout and still attaches diagnostics',async()=>{
 const controller=new AbortController();
 const pending=runExtractor(process.execPath,['-e','setInterval(()=>{},1000)'],controller.signal);
 controller.abort(new Error('stage_timeout'));
 const error=await pending.catch(e=>e);
 expect(error.message).toBe('stage_timeout');
 expect(error.diagnostics).toMatchObject({extractor_signal:'SIGKILL'});
});

it('redacts bearer tokens and multi-word identity values',()=>{
 expect(sanitizeExtractorDiagnostic('Authorization: Bearer supersecret\n',2048)).toBe('Authorization: <redacted>\n');
 expect(sanitizeExtractorDiagnostic('personaname: Alice Secret\n',2048)).toBe('personaname: <redacted>\n');
 expect(sanitizeExtractorDiagnostic('token=abc def\n',2048)).toBe('token=<redacted>\n');
 expect(sanitizeExtractorDiagnostic('Authorization: Bearer supersecret\n',2048)).not.toMatch(/supersecret|Alice|\babc\b|\bdef\b/);
});
