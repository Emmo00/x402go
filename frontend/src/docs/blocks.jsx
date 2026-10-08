import { Badge, CopyButton } from '../components/ui/primitives';
import { highlight } from './highlight';

/**
 * The presentation blocks the documentation is assembled from.
 *
 * Keeping them here means a change to how a response is shown, or how an
 * endpoint is introduced, lands on all sixteen sections at once instead of on
 * whichever ones happened to be edited.
 */

/* -------------------------------------------------------------------------- */
/* Code                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A code sample in the DESIGN.md panel treatment: Carbon on the page canvas,
 * a 1px hairline instead of a shadow, a monospace title bar, and the copy
 * action in the bar rather than floating over the text.
 *
 * The `pre` is focusable so a keyboard user can scroll a long line sideways
 * without a pointer; that is also why it scrolls rather than wraps — a wrapped
 * JSON body is much harder to read than one that runs off the edge.
 */
export function CodeBlock({ label, language = 'bash', code }) {
  return (
    <figure className="code">
      <figcaption className="code__bar">
        <span className="code__label mono">{label ?? language}</span>
        <CopyButton className="code__copy" label="Copy" ariaLabel={`Copy ${label ?? language} example`} value={code} />
      </figcaption>
      <pre className="code__pre" tabIndex={0}>
        <code>{highlight(code, language)}</code>
      </pre>
    </figure>
  );
}

/* -------------------------------------------------------------------------- */
/* Endpoint heading                                                           */
/* -------------------------------------------------------------------------- */

/**
 * DESIGN.md reserves Phosphor Green for state that is active or available, so
 * the badge reads green only when the endpoint can be called with no credential
 * at all. Anything needing a key is neutral — it is a requirement, not a state.
 */
export function Endpoint({ method, path, auth = 'API key' }) {
  const open = auth === 'Public';

  return (
    <p className="endpoint">
      <span className="endpoint__method mono">{method}</span>
      <code className="endpoint__path">{path}</code>
      <Badge tone={open ? 'active' : 'neutral'}>{auth}</Badge>
    </p>
  );
}

/* -------------------------------------------------------------------------- */
/* Tables                                                                     */
/* -------------------------------------------------------------------------- */

/** The shared hairline table from the dashboard, for parameters and codes. */
export function DataTable({ head, rows }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            {head.map((cell) => (
              <th key={cell} scope="col">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {row.map((cell, cellIndex) => (
                <td key={cellIndex}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Inline monospace for a field, a path or a value inside running prose. */
export function Mono({ children }) {
  return <code className="doc-code">{children}</code>;
}

/* -------------------------------------------------------------------------- */
/* Steps                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A numbered sequence, where the numbering is the content: these steps run in
 * order, and a reader who skips one gets a failure rather than a surprise.
 * Steps that are not sequences use ordinary prose instead.
 */
export function Steps({ children }) {
  return <ol className="steps">{children}</ol>;
}

export function Step({ n, title, children }) {
  return (
    <li className="step">
      <span className="step__index mono" aria-hidden="true">
        {String(n).padStart(2, '0')}
      </span>
      <div className="step__body">
        <h3 className="step__title">{title}</h3>
        {children}
      </div>
    </li>
  );
}
