let inFlightId: string | null = null

export const IN_FLIGHT_MESSAGE = 'Wait for the current AI request to finish, or cancel it.'

export function getInFlightRequestId(): string | null {
  return inFlightId
}

export function tryBeginRequest(): string | false {
  if (inFlightId) return false
  inFlightId = crypto.randomUUID()
  return inFlightId
}

export function finishRequest(requestId: string): void {
  if (inFlightId === requestId) inFlightId = null
}

export function isRequestInFlight(): boolean {
  return inFlightId !== null
}

/** Test-only. */
export function resetRequestLatch(): void {
  inFlightId = null
}
