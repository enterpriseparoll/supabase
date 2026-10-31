import { assertSelfHosted } from '../util'
import { AuthConfigStore } from './store'

let store: AuthConfigStore | undefined

/** One store per server process, so concurrent saves are applied in order. */
export function getAuthConfigStore() {
  assertSelfHosted()
  store ??= new AuthConfigStore({ root: process.env.AUTH_CONFIG_MANAGEMENT_FOLDER || undefined })
  return store
}
