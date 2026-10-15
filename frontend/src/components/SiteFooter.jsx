function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="container">
        <p className="site-footer__text">
          Powered by{' '}
          <a
            className="site-footer__link"
            href="https://celo.org"
            target="_blank"
            rel="noreferrer"
          >
            Celo
          </a>
        </p>
      </div>
    </footer>
  );
}

export default SiteFooter;
