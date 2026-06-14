// Test setup for web app
import { vi } from 'vitest';

function createStorageMock() {
  let store: Record<string, string> = {};

  return {
    getItem: (key: string) => (key in store ? store[key] : null),
    setItem: (key: string, value: string) => {
      store[key] = String(value);
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
    key: (index: number) => Object.keys(store)[index] ?? null,
    get length() {
      return Object.keys(store).length;
    },
  } as Storage;
}

// Guard: browser-only setup (storage, matchMedia, Notification) only applies
// when window exists (happy-dom). Route handler tests override to node env
// via `// @vitest-environment node` docblock — window is undefined there.
if (typeof window !== 'undefined') {
  if (
    !('localStorage' in window) ||
    !window.localStorage ||
    typeof window.localStorage.getItem !== 'function'
  ) {
    Object.defineProperty(window, 'localStorage', {
      writable: true,
      value: createStorageMock(),
    });
  }

  if (
    !('sessionStorage' in window) ||
    !window.sessionStorage ||
    typeof window.sessionStorage.getItem !== 'function'
  ) {
    Object.defineProperty(window, 'sessionStorage', {
      writable: true,
      value: createStorageMock(),
    });
  }

  // Mock window.matchMedia
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });

  // Mock Notification API
  Object.defineProperty(window, 'Notification', {
    writable: true,
    value: class MockNotification {
      static permission = 'default';
      static requestPermission = vi.fn().mockResolvedValue('granted');
      constructor() {}
      close = vi.fn();
    },
  });
}

// Mock Next.js router (works in any env — vi.mock is env-agnostic)
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
  }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));
