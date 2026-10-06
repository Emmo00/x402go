import { createContext, useContext } from 'react';

/**
 * The tail of the onboarding flow, carried past the route change.
 *
 * Router state was the obvious channel for this, and it does not hold: the
 * gate's "the wallet is saved" update is urgent while `navigate` is applied as
 * a transition, so the two land in different renders — and in the render where
 * the location is still `/dashboard`, the dashboard's index route redirects,
 * replacing the entry and the flag with it. Holding the flag in context means
 * nothing the router does between the two screens can drop it.
 *
 * Null for every account that did not just come through onboarding, which is
 * what keeps a deliberate visit to the API-key screen from silently issuing a
 * credential.
 */
export const OnboardingHandoff = createContext(null);

export function useOnboardingHandoff() {
  return useContext(OnboardingHandoff);
}
