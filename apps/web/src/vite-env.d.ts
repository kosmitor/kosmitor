/// <reference types="vite/client" />

/** Google Identity Services, loaded on demand by the sign-in page. */
interface GoogleCredentialResponse { credential: string; select_by?: string }
interface Window {
  google?: {
    accounts: {
      id: {
        initialize(options: Record<string, unknown>): void;
        renderButton(parent: HTMLElement, options: Record<string, unknown>): void;
        prompt(): void;
        cancel(): void;
      };
    };
  };
}
