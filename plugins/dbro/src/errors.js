/**
 * One plugin-owned failure class with stable codes for the read-only database seam. Tool bodies throw these so the
 * tool result keeps a routable `code`; cancellation stays an `AbortError` instead (see {@link executor.run}).
 * @module dbro/errors
 */

import { HarnessError } from '@deepseek-ai/dsh-error'

/** Stable failure codes reported on `tool/result`. */
export const DBRO_ERRORS = {
  /** A named source is not configured. */
  SOURCE_NOT_FOUND: 'DBRO_SOURCE_NOT_FOUND',
  /** Neither a source nor a dialect selects an engine. */
  MISSING_DIALECT: 'DBRO_MISSING_DIALECT',
  /** The source's dialect and the explicit dialect disagree. */
  DIALECT_MISMATCH: 'DBRO_DIALECT_MISMATCH',
  /** MySQL needs a database name that neither the source nor the call supplies. */
  MISSING_DATABASE: 'DBRO_MISSING_DATABASE',
  /** The bundled `dbro.py` and its executors cannot be found. */
  SCRIPTS_NOT_FOUND: 'DBRO_SCRIPTS_NOT_FOUND',
  /** The configured Python interpreter could not be started. */
  PYTHON_NOT_FOUND: 'DBRO_PYTHON_NOT_FOUND',
  /** Starting the interpreter failed for a reason other than a missing executable. */
  PYTHON_FAILED: 'DBRO_PYTHON_FAILED',
  /** The query exceeded its timeout and was killed. */
  TIMEOUT: 'DBRO_TIMEOUT',
  /** The read-only gate rejected the statement. */
  REJECTED: 'DBRO_REJECTED',
  /** The executor exited non-zero for a connection, driver, or SQL reason. */
  QUERY_FAILED: 'DBRO_QUERY_FAILED',
  /** The Python/driver probe could not run. */
  PROBE_FAILED: 'DBRO_PROBE_FAILED',
}

/** Failures raised by the DBRO plugin itself. */
export class DbroError extends HarnessError {
  /**
   * @param message - localized, actionable report for the model.
   * @param code - one of {@link DBRO_ERRORS}.
   * @param options - optional chained cause for a foreign failure.
   */
  constructor(message, code, options) {
    super(message, code, options)
  }
}
