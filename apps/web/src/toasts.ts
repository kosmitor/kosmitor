/**
 * What a toast is, apart from how it is drawn (ToastProvider in ui.tsx draws
 * them). Kept free of React and the page so the rules can be tested on their
 * own: the web app has no test runner, so apps/server/test/toasts.test.ts
 * checks them.
 *
 * Every page calls toast(message) or toast(message, tone). An action is an
 * optional third argument, so those calls read and behave as they always have.
 */
export type ToastTone = 'success' | 'error' | 'info';

/** A button in the toast, such as Undo. Pressing it also dismisses the toast. */
export interface ToastAction { label: string; onClick: () => void }

export interface Toast { id: number; message: string; tone: ToastTone; action?: ToastAction }

export type ShowToast = (message: string, tone?: ToastTone, action?: ToastAction) => void;

/** Long enough to read a sentence. */
export const TOAST_MS = 4200;
/** A toast with a button stays longer, so there is time to reach for it. */
export const TOAST_WITH_ACTION_MS = 8000;
/** Once the pointer or focus leaves a toast it was holding open, it goes after this. */
export const TOAST_RELEASE_MS = 2500;

/** The toast a call makes. An action with no label to show is left off rather than drawn as an empty button. */
export function makeToast(id: number, message: string, tone: ToastTone = 'success', action?: ToastAction): Toast {
  return action && action.label.trim() !== '' ? { id, message, tone, action } : { id, message, tone };
}

export const toastLifetime = (toast: Toast): number => (toast.action ? TOAST_WITH_ACTION_MS : TOAST_MS);
