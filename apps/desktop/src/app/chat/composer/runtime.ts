const COMPOSER_UNAVAILABLE_MESSAGE = 'Composer is not available'

export function safeComposerAction(action: () => void): boolean {
  try {
    action()

    return true
  } catch (error) {
    if (error instanceof Error && error.message === COMPOSER_UNAVAILABLE_MESSAGE) {
      return false
    }

    throw error
  }
}
