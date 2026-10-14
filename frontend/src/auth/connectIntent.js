/**
 * Whether the wallet connection now in flight was asked for by the user.
 *
 * wagmi reconnects a previously authorised wallet on mount, and that connection
 * is indistinguishable from one the user just made — except that nobody
 * clicked anything. A connect control records the intent here, so the automatic
 * sign-in can tell the two apart: a connection that lands with the intent set
 * signs itself in, a restored one waits for a deliberate press.
 *
 * A module rather than React state because nobody renders it: it is written by
 * a click handler and read by an effect watching the connection. Reading it
 * clears it, so one press authorises exactly one connection.
 */
let requested = false;

export function markConnectIntent() {
  requested = true;
}

export function consumeConnectIntent() {
  const wasRequested = requested;
  requested = false;
  return wasRequested;
}
