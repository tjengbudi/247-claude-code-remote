/**
 * Utils Module Tests
 *
 * Tests for utility functions used across the application.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { cn, stripProtocol, buildWebSocketUrl, buildApiUrl } from '@/lib/utils';

describe('Utils', () => {
  describe('cn function', () => {
    it('merges class names', () => {
      expect(cn('foo', 'bar')).toBe('foo bar');
    });

    it('handles conditional classes', () => {
      const showBar = true;
      const showBaz = false;
      expect(cn('foo', showBar && 'bar', showBaz && 'baz')).toBe('foo bar');
    });

    it('handles undefined values', () => {
      expect(cn('foo', undefined, 'bar')).toBe('foo bar');
    });

    it('handles null values', () => {
      expect(cn('foo', null, 'bar')).toBe('foo bar');
    });

    it('handles arrays of classes', () => {
      expect(cn(['foo', 'bar'], 'baz')).toBe('foo bar baz');
    });

    it('handles object notation', () => {
      expect(cn({ foo: true, bar: false, baz: true })).toBe('foo baz');
    });

    it('merges Tailwind classes correctly', () => {
      // tw-merge should keep only the last conflicting utility
      expect(cn('p-2', 'p-4')).toBe('p-4');
    });

    it('merges color utilities correctly', () => {
      expect(cn('text-red-500', 'text-blue-500')).toBe('text-blue-500');
    });

    it('keeps non-conflicting classes', () => {
      expect(cn('p-2', 'm-4', 'text-lg')).toBe('p-2 m-4 text-lg');
    });

    it('handles empty input', () => {
      expect(cn()).toBe('');
    });

    it('handles single class', () => {
      expect(cn('foo')).toBe('foo');
    });

    it('handles complex conditional expressions', () => {
      const isActive = true;
      const isDisabled = false;

      expect(
        cn('base-class', isActive && 'active-class', isDisabled && 'disabled-class', {
          'object-class': true,
          'hidden-class': false,
        })
      ).toBe('base-class active-class object-class');
    });

    it('handles Tailwind responsive utilities', () => {
      expect(cn('p-2', 'sm:p-4', 'md:p-6')).toBe('p-2 sm:p-4 md:p-6');
    });

    it('handles Tailwind state modifiers', () => {
      expect(cn('hover:bg-blue-500', 'focus:bg-blue-600')).toBe(
        'hover:bg-blue-500 focus:bg-blue-600'
      );
    });
  });

  describe('stripProtocol', () => {
    it('strips https:// protocol', () => {
      expect(stripProtocol('https://example.com')).toBe('example.com');
    });

    it('strips http:// protocol', () => {
      expect(stripProtocol('http://example.com')).toBe('example.com');
    });

    it('strips wss:// protocol', () => {
      expect(stripProtocol('wss://example.com')).toBe('example.com');
    });

    it('strips ws:// protocol', () => {
      expect(stripProtocol('ws://example.com')).toBe('example.com');
    });

    it('preserves port numbers', () => {
      expect(stripProtocol('https://example.com:4678')).toBe('example.com:4678');
    });

    it('preserves path', () => {
      expect(stripProtocol('https://example.com/path/to/resource')).toBe(
        'example.com/path/to/resource'
      );
    });

    it('returns unchanged URL without protocol', () => {
      expect(stripProtocol('example.com:4678')).toBe('example.com:4678');
    });

    it('handles localhost with protocol', () => {
      expect(stripProtocol('http://localhost:4678')).toBe('localhost:4678');
    });

    it('handles Tailscale URLs', () => {
      expect(stripProtocol('https://macbook-pro.tail5f910b.ts.net:4678')).toBe(
        'macbook-pro.tail5f910b.ts.net:4678'
      );
    });
  });

  describe('buildWebSocketUrl', () => {
    const originalProtocol = window.location.protocol;

    afterEach(() => {
      Object.defineProperty(window, 'location', {
        value: { ...window.location, protocol: originalProtocol },
        writable: true,
      });
    });

    function setPageProtocol(protocol: 'http:' | 'https:') {
      Object.defineProperty(window, 'location', {
        value: { ...window.location, protocol },
        writable: true,
      });
    }

    it('builds ws:// URL when page is http (localhost)', () => {
      setPageProtocol('http:');
      expect(buildWebSocketUrl('localhost:4678', '/status')).toBe('ws://localhost:4678/status');
    });

    it('builds ws:// URL when page is http (127.0.0.1)', () => {
      setPageProtocol('http:');
      expect(buildWebSocketUrl('127.0.0.1:4678', '/status')).toBe('ws://127.0.0.1:4678/status');
    });

    it('builds ws:// URL when page is http (LAN IP)', () => {
      setPageProtocol('http:');
      expect(buildWebSocketUrl('192.168.1.50:4678', '/status')).toBe(
        'ws://192.168.1.50:4678/status'
      );
    });

    it('builds wss:// URL when page is https (any domain)', () => {
      setPageProtocol('https:');
      expect(buildWebSocketUrl('example.com:4678', '/status')).toBe(
        'wss://example.com:4678/status'
      );
    });

    it('builds ws:// URL when page is http (any domain)', () => {
      setPageProtocol('http:');
      expect(buildWebSocketUrl('example.com:4678', '/status')).toBe(
        'ws://example.com:4678/status'
      );
    });

    it('strips existing https:// protocol before building URL', () => {
      setPageProtocol('http:');
      expect(buildWebSocketUrl('https://example.com:4678', '/status')).toBe(
        'ws://example.com:4678/status'
      );
    });

    it('strips existing http:// protocol before building URL', () => {
      setPageProtocol('https:');
      expect(buildWebSocketUrl('http://localhost:4678', '/status')).toBe(
        'wss://localhost:4678/status'
      );
    });

    it('handles Tailscale URLs - page https → wss', () => {
      setPageProtocol('https:');
      expect(buildWebSocketUrl('macbook-pro.tail5f910b.ts.net:4678', '/status')).toBe(
        'wss://macbook-pro.tail5f910b.ts.net:4678/status'
      );
    });

    it('handles Tailscale URLs - page http → ws', () => {
      setPageProtocol('http:');
      expect(buildWebSocketUrl('macbook-pro.tail5f910b.ts.net:4678', '/status')).toBe(
        'ws://macbook-pro.tail5f910b.ts.net:4678/status'
      );
    });

    it('handles host.local names - page http → ws', () => {
      setPageProtocol('http:');
      expect(buildWebSocketUrl('host.local:4678', '/status')).toBe('ws://host.local:4678/status');
    });

    it('handles paths with query parameters', () => {
      setPageProtocol('http:');
      expect(buildWebSocketUrl('localhost:4678', '/terminal?project=test&session=s1')).toBe(
        'ws://localhost:4678/terminal?project=test&session=s1'
      );
    });

    it('handles complex paths', () => {
      setPageProtocol('https:');
      expect(buildWebSocketUrl('example.com:4678', '/api/v1/websocket')).toBe(
        'wss://example.com:4678/api/v1/websocket'
      );
    });

    it('handles already-prefixed agent URL without doubling protocol', () => {
      setPageProtocol('http:');
      expect(buildWebSocketUrl('http://192.168.1.50:4678', '/status')).toBe(
        'ws://192.168.1.50:4678/status'
      );
    });
  });

  describe('buildApiUrl', () => {
    const originalProtocol = window.location.protocol;

    afterEach(() => {
      Object.defineProperty(window, 'location', {
        value: { ...window.location, protocol: originalProtocol },
        writable: true,
      });
    });

    function setPageProtocol(protocol: 'http:' | 'https:') {
      Object.defineProperty(window, 'location', {
        value: { ...window.location, protocol },
        writable: true,
      });
    }

    it('builds http:// URL when page is http (localhost)', () => {
      setPageProtocol('http:');
      expect(buildApiUrl('localhost:4678', '/api/sessions')).toBe(
        'http://localhost:4678/api/sessions'
      );
    });

    it('builds http:// URL when page is http (127.0.0.1)', () => {
      setPageProtocol('http:');
      expect(buildApiUrl('127.0.0.1:4678', '/api/sessions')).toBe(
        'http://127.0.0.1:4678/api/sessions'
      );
    });

    it('builds http:// URL when page is http (LAN IP)', () => {
      setPageProtocol('http:');
      expect(buildApiUrl('192.168.1.50:4678', '/api/sessions')).toBe(
        'http://192.168.1.50:4678/api/sessions'
      );
    });

    it('builds https:// URL when page is https (any domain)', () => {
      setPageProtocol('https:');
      expect(buildApiUrl('example.com:4678', '/api/sessions')).toBe(
        'https://example.com:4678/api/sessions'
      );
    });

    it('builds http:// URL when page is http (any domain)', () => {
      setPageProtocol('http:');
      expect(buildApiUrl('example.com:4678', '/api/sessions')).toBe(
        'http://example.com:4678/api/sessions'
      );
    });

    it('strips existing https:// protocol before building URL', () => {
      setPageProtocol('https:');
      expect(buildApiUrl('https://example.com:4678', '/api/sessions')).toBe(
        'https://example.com:4678/api/sessions'
      );
    });

    it('strips existing http:// protocol before building URL', () => {
      setPageProtocol('http:');
      expect(buildApiUrl('http://localhost:4678', '/api/sessions')).toBe(
        'http://localhost:4678/api/sessions'
      );
    });

    it('handles Tailscale URLs - page https → https', () => {
      setPageProtocol('https:');
      expect(buildApiUrl('macbook-pro.tail5f910b.ts.net:4678', '/api/sessions')).toBe(
        'https://macbook-pro.tail5f910b.ts.net:4678/api/sessions'
      );
    });

    it('handles Tailscale URLs - page http → http', () => {
      setPageProtocol('http:');
      expect(buildApiUrl('macbook-pro.tail5f910b.ts.net:4678', '/api/sessions')).toBe(
        'http://macbook-pro.tail5f910b.ts.net:4678/api/sessions'
      );
    });

    it('handles paths with query parameters', () => {
      setPageProtocol('http:');
      expect(buildApiUrl('localhost:4678', '/api/clone/preview?url=test')).toBe(
        'http://localhost:4678/api/clone/preview?url=test'
      );
    });

    it('handles complex paths', () => {
      setPageProtocol('https:');
      expect(buildApiUrl('example.com:4678', '/api/sessions/test/archive')).toBe(
        'https://example.com:4678/api/sessions/test/archive'
      );
    });

    it('handles URL with double protocol correctly', () => {
      // URLs with existing protocol should not double up
      setPageProtocol('https:');
      expect(
        buildApiUrl('https://macbook-pro.tail5f910b.ts.net:4678', '/api/sessions/archived')
      ).toBe('https://macbook-pro.tail5f910b.ts.net:4678/api/sessions/archived');
    });

    it('handles already-prefixed agent URL without doubling protocol', () => {
      setPageProtocol('http:');
      expect(buildApiUrl('http://192.168.1.50:4678', '/api/sessions')).toBe(
        'http://192.168.1.50:4678/api/sessions'
      );
    });
  });
});
