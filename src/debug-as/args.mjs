// One grammar for the operator launch and three agent-safe verbs. Help belongs
// to commands.mjs; the delimiter is the ownership boundary for child arguments.
// Reject conflicts before filesystem, adapter, browser or phone mutations.
import { pathProblem } from './config.mjs';

const usage = 'ax debug-as --help';
const fail = message => { throw Object.assign(new Error(message), { fix: usage, exitCode: 2 }); };
export function parseDebugArgs(argv = []) {
  const args = [...argv];
  const verb = args[0] && !args[0].startsWith('-') ? args.shift() : 'launch';
  if (!['launch', 'doctor', 'status', 'drive'].includes(verb)) fail(`unknown debug-as verb ${verb}`);
  const result = { verb, name: null, path: null, device: null, viewport: null, phone: false, noPhone: false, argv: [] };
  const seen = new Set();
  const values = new Map([['--as', 'name'], ['--path', 'path'], ['--device', 'device'], ['--viewport', 'viewport']]);
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (flag === '--' && verb === 'drive') {
      result.argv = args.slice(i + 1);
      if (!result.argv.length) fail('drive requires child arguments after --');
      break;
    }
    if (seen.has(flag)) fail(`duplicate argument ${flag}`);
    seen.add(flag);
    if (verb === 'status' || verb === 'doctor') fail(`${verb} accepts no arguments`);
    if (verb === 'drive' && flag !== '--as') fail('drive accepts only --as before its required -- delimiter');
    if (values.has(flag)) {
      const value = args[++i];
      if (typeof value !== 'string' || !value || value.startsWith('--')) fail(`${flag} requires a value`);
      result[values.get(flag)] = value;
    } else if (flag === '--phone') result.phone = true;
    else if (flag === '--no-phone') result.noPhone = true;
    else fail(`unknown argument ${flag}`);
  }
  if (verb === 'drive' && !result.argv.length) fail('drive requires -- followed by child arguments');
  if (verb === 'launch' && !result.name) fail('launch requires --as <identity>');
  if (result.name !== null && !/^[a-z][a-z0-9-]*$/.test(result.name)) fail('identity must use lowercase letters, digits and hyphens');
  if (result.phone && result.noPhone) fail('--phone and --no-phone are mutually exclusive');
  if (result.device && result.viewport) fail('--device and --viewport are mutually exclusive');
  if (result.path !== null) {
    const problem = pathProblem(result.path);
    if (problem) fail(`--path ${problem}`);
  }
  if (result.viewport) {
    const match = /^(\d{3,5})x(\d{3,5})$/.exec(result.viewport);
    if (!match || match.slice(1).some(value => Number(value) < 200 || Number(value) > 10000)) fail('--viewport must be WIDTHxHEIGHT, each from 200 to 10000');
    result.viewport = { width: Number(match[1]), height: Number(match[2]) };
  }
  return result;
}
