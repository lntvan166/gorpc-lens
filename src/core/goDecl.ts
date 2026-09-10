// Line-level parsing of Go method declarations.
//
// Kept deliberately small: the extension only ever needs the receiver type and
// the method name of a single declaration line, never a real Go parse.

const RECEIVER = /^func\s*\(\s*(?:\w+\s+)?\*?(\w+)\s*\)/;

/** A method on a receiver taking a context first — the shape of every gRPC handler. */
const HANDLER_DECL = /^func\s*\(\s*\w+\s+\*?\w+\s*\)\s+([A-Z]\w*)\(\s*\w+\s+context\.Context/;

/** Handles both `func (h *T)` and the anonymous `func (T)` that generated
 *  Unimplemented stubs use. */
export function receiverTypeFromLine(line: string): string | undefined {
  return RECEIVER.exec(line)?.[1];
}

export interface HandlerMethod {
  name: string;
  character: number;
}

/**
 * Locate the method name in a handler declaration line.
 *
 * The name is searched for *after* the receiver's closing paren. Searching the
 * whole line would find the name inside the receiver type instead whenever one
 * contains the other — `func (h *EchoHandler) Echo(` being the obvious case.
 */
export function findHandlerMethod(line: string): HandlerMethod | undefined {
  const m = HANDLER_DECL.exec(line);
  if (!m) {
    return undefined;
  }
  const receiverEnd = line.indexOf(')');
  const character = line.indexOf(m[1], receiverEnd);
  if (character < 0) {
    return undefined;
  }
  return { name: m[1], character };
}
