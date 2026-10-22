import { BENEFITS } from '../constants';

function Benefits() {
  return (
    <section className="section" aria-labelledby="benefits-title">
      <div className="container">
        <h2 className="section__title section__title--wide" id="benefits-title">
          Everything you need to accept x402 payments
        </h2>
        <ol className="benefits__grid">
          {BENEFITS.map((benefit, index) => (
            <li className="benefit" key={benefit.title}>
              <span className="benefit__index" aria-hidden="true">
                {String(index + 1).padStart(2, '0')}
              </span>
              <h3 className="benefit__title">{benefit.title}</h3>
              <p className="benefit__body">{benefit.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

export default Benefits;
