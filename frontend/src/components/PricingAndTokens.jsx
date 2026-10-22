import { FEE_PER_TX, EXAMPLE_PAYMENTS, TOKENS, usd, FEE_PER_TX_NGN } from '../constants';

function PricingAndTokens() {
  return (
    <section className="section" aria-label="Fees and supported tokens">
      <div className="container duo">
        <div className="duo__col" id="fees">
          <h2 className="section__title">One fee</h2>
          <div className="panel">
            <table className="fee-table">
              <caption className="sr-only">Example payments after fees</caption>
              <thead>
                <tr>
                  <th scope="col">Customer pays</th>
                  <th scope="col">You receive</th>
                  <th scope="col">Fee</th>
                </tr>
              </thead>
              <tbody>
                {EXAMPLE_PAYMENTS.map((amount) => (
                  <tr key={amount}>
                    <th scope="row">${((amount)).toFixed(2)}</th>
                    <td className="fee-table__net">{usd(amount - FEE_PER_TX)}</td>
                    <td>{usd(FEE_PER_TX)}</td>
                  </tr>
                ))}
                <tr key="naira">
                    <th colSpan={3} scope="row">Fees for cNGN settlement is ₦{FEE_PER_TX_NGN.toFixed(2)} per transaction </th>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div className="duo__col" id="tokens">
          <h2 className="section__title">Supported tokens</h2>
          <ul className="panel tokens">
            {TOKENS.map((token) => (
              <li className="token" key={token.symbol}>
                <span className="token__symbol">{token.symbol}</span>
                <span className="token__name">{token.name}</span>
                <span className="token__auth">{token.auth}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

export default PricingAndTokens;
