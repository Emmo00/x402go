function SiteHeader() {
  return (
    <header className="site-header">
      <div className="container site-header__inner">
        <a className="logo" href="/" aria-label="x402Go home">
          x402G<span className="logo__accent">o</span>
        </a>
        <nav className="site-header__nav" aria-label="Page sections">
          <a className="site-header__link" href="#tokens">
            Tokens
          </a>
          <a className="site-header__link" href="https://github.com/Emmo00/x402go" target="_blank" rel="noopener noreferrer">
            GitHub
          </a>
          <a className="site-header__link" href="https://docs.x402go.online" target="_blank" rel="noopener noreferrer">
            Docs
          </a>
          <a className="site-header__link" href="https://docs.x402go.online/llms-full.txt" target="_blank" rel="noopener noreferrer">
            LLMS.txt
          </a>
        </nav>
      </div>
    </header>
  );
}

export default SiteHeader;
