import { executedInvocations } from './lib/shell-invocation.mjs';
import { withoutInterpreterSource } from './native-effect-interpreter-source.mjs';
import { proveProgramSelection } from './native-effect-program-selection.mjs';

const quote = (word) => `'${word.replaceAll("'", "'\\''")}'`;

/** Project targets from the original shared reader; retain its code/argv evidence.
 * PATH chooses an executable; observation must prove its selection before it can
 * leave target text. The same observed program may establish a bounded inline
 * application's data channel even when PATH is inherited. Neither observation
 * nor projection grants execution authority.
 */
export function invocationTargetView(command, cwd) {
  const reader = executedInvocations(command, { cwd });
  const call = completeDirectInvocation(reader);
  if (!call) return null;
  const hasPath = call.environment?.some((word) => word.startsWith('PATH='));
  const operands = ['echo', 'printf'].includes(call.name) ? [] : call.programOperands;
  // Empty argv slots are real slots: dropping an empty -e value could promote
  // a later loader option into the code slot and erase its actual path.
  const programText = [call.program, ...operands].map(quote).join(' ');
  const projected = withoutInterpreterSource(programText, { opaqueArguments: true });
  if (!hasPath && projected === withoutInterpreterSource(programText)) return null;
  const programSelection = proveProgramSelection(call);
  if (!programSelection) return null;
  const configuration = call.environment.filter((word) => !word.startsWith('PATH='));
  const targets = [projected, ...configuration.map(quote)];
  for (const redirect of call.redirections ?? []) {
    if (!redirect.operand?.literal) return null;
    targets.push(`${redirect.operator}${quote(redirect.operand.value)}`);
  }
  return { text: targets.join(' '), call, programSelection };
}

function completeDirectInvocation(reader) {
  const calls = reader.directInvocations;
  if (!reader.complete || calls?.length !== 1) return null;
  const call = calls[0];
  if (!call.argvComplete || !call.coordinateKnown || call.delegated || call.generatedCode) return null;
  if (typeof call.program !== 'string' || !call.program) return null;
  // Generated argv and code remain on the conservative original-source path.
  if (call.argumentEvidence?.length || call.unprovedCodeEvidence?.length) return null;
  return call;
}
