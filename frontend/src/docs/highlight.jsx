/**
 * Syntax colouring for the code samples on /docs.
 *
 * DESIGN.md gives the terminal/code panel its own treatment: monospace at 13px
 * on Carbon, with structure carried by colour — violet for keys, green for
 * values, a dim green for comments. This is that scheme and nothing more.
 *
 * It is deliberately not a parser. Every sample on the page is a short, literal
 * block, so a single left-to-right pass over a handful of patterns is both
 * sufficient and predictable: scanning runs once over the original text, and
 * matched spans are never re-scanned, so no rule can colour the output of
 * another. The consequence worth knowing is that position decides — a `//`
 * inside a string is never a comment, because the string starts earlier and is
 * consumed whole.
 *
 * Every pattern must use non-capturing groups only. The scanner wraps each
 * pattern in one capturing group to learn which rule matched; a capturing group
 * inside a pattern would shift that mapping.
 */

const LANGUAGES = {
  json: [
    // A quoted string followed by a colon is a key, not a value. The lookahead
    // keeps the colon itself uncoloured.
    { className: 'tok-key', pattern: /"(?:[^"\\]|\\.)*"(?=\s*:)/ },
    { className: 'tok-val', pattern: /\b(?:true|false|null)\b/ },
    { className: 'tok-val', pattern: /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/ },
  ],

  bash: [
    // The `$` a shell prints. Anchored, so it never catches a `$` in prose or
    // in a template placeholder.
    { className: 'tok-prompt', pattern: /^\$/m },
    { className: 'tok-str', pattern: /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/ },
    // Requires whitespace before the `#`, so a URL fragment or an anchor in a
    // path is not mistaken for a comment.
    { className: 'tok-cm', pattern: /(?:^|\s)#[^\n]*/ },
  ],

  ts: [
    { className: 'tok-str', pattern: /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/ },
    { className: 'tok-cm', pattern: /\/\/[^\n]*/ },
    { className: 'tok-cm', pattern: /\/\*[\s\S]*?\*\// },
    {
      className: 'tok-kw',
      pattern:
        /\b(?:const|let|var|function|return|await|async|import|export|from|new|class|if|else|try|catch|finally|throw|typeof|instanceof|interface|type|as|of|in|for|while|extends|implements|readonly|public|private)\b/,
    },
  ],
};

/**
 * Split `code` into plain strings and `{ text, className }` spans.
 *
 * Returning data rather than elements keeps this testable without rendering,
 * and lets the caller decide how to key the spans.
 */
export function tokenize(code, language) {
  const rules = LANGUAGES[language];
  if (!rules) return [code];

  const combined = new RegExp(rules.map((rule) => `(${rule.pattern.source})`).join('|'), 'gm');
  const parts = [];
  let cursor = 0;
  let match;

  while ((match = combined.exec(code)) !== null) {
    // A pattern that can match the empty string would spin forever here.
    if (match[0] === '') {
      combined.lastIndex += 1;
      continue;
    }

    if (match.index > cursor) parts.push(code.slice(cursor, match.index));

    // The first group that actually participated identifies the rule.
    const group = match.slice(1).findIndex((value) => value !== undefined);
    parts.push({ text: match[0], className: rules[group].className });

    cursor = match.index + match[0].length;
  }

  if (cursor < code.length) parts.push(code.slice(cursor));
  return parts;
}

/**
 * The same split, as React nodes.
 *
 * Keys are positional and the parts are never reordered, so the index is a
 * stable identity here.
 */
export function highlight(code, language) {
  return tokenize(code, language).map((part, index) =>
    typeof part === 'string' ? (
      part
    ) : (
      <span className={part.className} key={index}>
        {part.text}
      </span>
    ),
  );
}
