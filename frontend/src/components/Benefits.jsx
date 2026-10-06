const BENEFITS = [
  {
    title: 'No upfront funding',
    body: 'Start accepting payments without depositing money into a facilitator balance.',
  },
  {
    title: 'Pay as you go',
    body: 'Your facilitator fees are deducted automatically from the payments you receive. No manual top-ups.',
  },
  {
    title: 'One API key',
    body: 'Sign up, get your API key, and integrate x402Go into your application.',
  },
  {
    title: 'Built for developers',
    body: 'Simple APIs, straightforward integration, and everything you need to get your x402 payments running.',
  },
  {
    title: 'Payment analytics',
    body: 'See your payments, revenue, fees, and usage from one dashboard.',
  },
  {
    title: 'Transparent payment history',
    body: "Know exactly what you've received and what you've paid in fees.",
  },
];

function Benefits() {
  return (
    <section className="benefits" aria-labelledby="benefits-title">
      <div className="container">
        <h2 className="benefits__heading" id="benefits-title">
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
