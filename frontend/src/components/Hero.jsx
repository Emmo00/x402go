import { API_KEY_ROUTE } from '../routes';

function Hero() {
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="container">
        <div className="hero__inner">
          <h1 className="hero__title" id="hero-title">
            x402Go
          </h1>
          <h2 className="hero__tagline">
            Start accepting x402 payments immediately.
          </h2>
          <p className="hero__description">
            A pay-as-you-go x402 facilitator for developers. Fees are
            automatically deducted from each payment.
          </p>
          <a className="btn btn--primary" href={API_KEY_ROUTE}>
            Get your API key →
          </a>
        </div>
      </div>
    </section>
  );
}

export default Hero;
