import { API_KEY_ROUTE } from '../routes';

function FinalCta() {
  return (
    <section className="final-cta" aria-labelledby="final-cta-title">
      <div className="container">
        <div className="final-cta__inner">
          <h2 className="final-cta__title" id="final-cta-title">
            Start accepting x402 payments
          </h2>
          <p className="final-cta__body">
            No pre-funding. No top-ups. Just plug in your API key and start
            building.
          </p>
          <a className="btn btn--primary" href={API_KEY_ROUTE}>
            Get your API key
          </a>
        </div>
      </div>
    </section>
  );
}

export default FinalCta;
