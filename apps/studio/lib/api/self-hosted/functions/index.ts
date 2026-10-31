import assert from 'node:assert'

import { assertSelfHosted } from '../util'
import { FileSystemFunctionsArtifactStore } from './fileSystemStore'
import { FunctionsManager } from './manage'

export function getFunctionsArtifactStore() {
  assertSelfHosted()
  assert(
    process.env.EDGE_FUNCTIONS_MANAGEMENT_FOLDER,
    'EDGE_FUNCTIONS_MANAGEMENT_FOLDER is required'
  )

  return new FileSystemFunctionsArtifactStore(process.env.EDGE_FUNCTIONS_MANAGEMENT_FOLDER)
}

/** Writes to the functions folder: deploy, delete, and secrets. */
export function getFunctionsManager() {
  assertSelfHosted()
  assert(
    process.env.EDGE_FUNCTIONS_MANAGEMENT_FOLDER,
    'EDGE_FUNCTIONS_MANAGEMENT_FOLDER is required'
  )

  return new FunctionsManager(process.env.EDGE_FUNCTIONS_MANAGEMENT_FOLDER)
}
