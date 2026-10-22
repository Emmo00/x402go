import { useState } from 'react';
import { API_KEY_ROUTE } from '../routes';
import { FEE_PER_TX, usd, SNIPPETS } from '../constants';

function Hero() {
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="container">
        <div className="hero__inner">
          <h1 className="hero__title rise" id="hero-title" style={{ '--i': 0 }}>
            Start accepting x402 payments immediately.
          </h1>
          <p className="hero__description rise" style={{ '--i': 1 }}>
            A pay-as-you-go x402 facilitator on Celo. No balance to fund, no credits to buy. Fees come out of each
            payment you receive.
          </p>
          <div className="hero__actions rise" style={{ '--i': 2 }}>
            <a className="btn btn--primary" href={API_KEY_ROUTE}>
              Get your API key →
            </a>
            <a className="hero__link" href="#fees">
              {usd(FEE_PER_TX)} per settled payment
            </a>
          </div>
          <CodePanel />
        </div>
      </div>
    </section>
  );
}

function CodePanel() {
  const [active, setActive] = useState(0);
  const [copied, setCopied] = useState(false);
  const [switched, setSwitched] = useState(false);

  const current = SNIPPETS[active];
  // Reserve the height of the longest snippet so switching tabs doesn't jump.
  const tallest = Math.max(...SNIPPETS.map((s) => s.lines.length));

  function select(index) {
    setActive(index);
    setSwitched(true);
    setCopied(false);
  }

  function onKeyDown(event) {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = (active + step + SNIPPETS.length) % SNIPPETS.length;
    select(next);
    document.getElementById(`code-tab-${SNIPPETS[next].id}`)?.focus();
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(current.lines.join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard unavailable; ignore */
    }
  }

  return (
    <figure className="panel code rise" style={{ '--i': 3 }} aria-label="Accept and send an x402 payment">
      <div className="code__bar">
        <div className="code__tabs" role="tablist" onKeyDown={onKeyDown}>
          {SNIPPETS.map((snippet, index) => (
            <button
              className="code__tab"
              role="tab"
              type="button"
              key={snippet.id}
              id={`code-tab-${snippet.id}`}
              aria-selected={index === active}
              aria-controls="code-panel"
              tabIndex={index === active ? 0 : -1}
              onClick={() => select(index)}
            >
              {snippet.file}
            </button>
          ))}
        </div>
        <button className="code__copy" type="button" onClick={copy}>
          <span aria-live="polite">{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      <pre
        className="code__body"
        id="code-panel"
        role="tabpanel"
        aria-labelledby={`code-tab-${current.id}`}
        tabIndex={0}
        key={current.id}
        style={{
          '--lines': tallest,
          '--base': switched ? '0ms' : '560ms',
        }}
      >
        <code>
          {current.lines.map((line, i) => (
            <span className="code__line" style={{ '--i': i }} key={i}>
              {line}
            </span>
          ))}
        </code>
      </pre>
    </figure>
  );
}

export default Hero;
