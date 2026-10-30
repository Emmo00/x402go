import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import App from './App';

// The landing page is the only route that renders without a wallet provider,
// so it is the one covered end to end here.
function renderLanding() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <App />
    </MemoryRouter>,
  );
}

test('renders the hero headline and both API key calls to action', () => {
  renderLanding();

  expect(
    screen.getByRole('heading', {
      level: 1,
      name: 'Start accepting x402 payments immediately.',
    }),
  ).toBeInTheDocument();

  const ctas = screen.getAllByRole('link', { name: /get your api key/i });
  expect(ctas).toHaveLength(2);
  ctas.forEach((cta) => expect(cta).toHaveAttribute('href', '/signup'));
});

test('lists all six benefits', () => {
  renderLanding();

  const benefits = screen.getByRole('heading', {
    level: 2,
    name: 'Everything you need to accept x402 payments',
  }).closest('section');

  expect(within(benefits).getAllByRole('listitem')).toHaveLength(6);
  expect(
    screen.getByRole('heading', { level: 3, name: 'No upfront funding' }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole('heading', { level: 3, name: 'Transparent history' }),
  ).toBeInTheDocument();
});
