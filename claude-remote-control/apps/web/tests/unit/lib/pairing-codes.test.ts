import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerPairingCode,
  lookupPairingCode,
  pairingCodes,
} from '@/lib/pairing-codes';

describe('pairing-codes', () => {
  beforeEach(() => {
    pairingCodes.clear();
  });

  describe('registerPairingCode', () => {
    it('should register a pairing code with token', () => {
      const info = {
        code: '123456',
        machineId: 'test-machine',
        machineName: 'Test Machine',
        agentUrl: 'localhost:4678',
        token: 'test-agent-token',
      };

      registerPairingCode(info);

      const stored = pairingCodes.get('123456');
      expect(stored).toBeDefined();
      expect(stored?.token).toBe('test-agent-token');
    });

    it('should register a pairing code without token (optional)', () => {
      const info = {
        code: '789012',
        machineId: 'test-machine',
        machineName: 'Test Machine',
        agentUrl: 'localhost:4678',
      };

      registerPairingCode(info);

      const stored = pairingCodes.get('789012');
      expect(stored).toBeDefined();
      expect(stored?.token).toBeUndefined();
    });

    it('should set 5-minute TTL', () => {
      const info = {
        code: '345678',
        machineId: 'test-machine',
        machineName: 'Test Machine',
        agentUrl: 'localhost:4678',
      };

      const before = Date.now();
      registerPairingCode(info);
      const after = Date.now();

      const stored = pairingCodes.get('345678');
      expect(stored).toBeDefined();
      expect(stored?.expiresAt).toBeGreaterThanOrEqual(before + 5 * 60 * 1000);
      expect(stored?.expiresAt).toBeLessThanOrEqual(after + 5 * 60 * 1000);
    });

    it('should remove existing codes for same machineId', () => {
      registerPairingCode({
        code: '111111',
        machineId: 'machine-1',
        machineName: 'Machine 1',
        agentUrl: 'localhost:4678',
      });

      registerPairingCode({
        code: '222222',
        machineId: 'machine-1',
        machineName: 'Machine 1',
        agentUrl: 'localhost:4678',
      });

      expect(pairingCodes.has('111111')).toBe(false);
      expect(pairingCodes.has('222222')).toBe(true);
    });
  });

  describe('lookupPairingCode', () => {
    it('should lookup a valid code and return token', () => {
      registerPairingCode({
        code: '123456',
        machineId: 'test-machine',
        machineName: 'Test Machine',
        agentUrl: 'localhost:4678',
        token: 'test-token',
      });

      const result = lookupPairingCode('123456');

      expect(result).toBeDefined();
      expect(result?.token).toBe('test-token');
      expect(result?.machineId).toBe('test-machine');
    });

    it('should return null for non-existent code', () => {
      const result = lookupPairingCode('999999');
      expect(result).toBeNull();
    });

    it('should return null and delete expired code', () => {
      registerPairingCode({
        code: '123456',
        machineId: 'test-machine',
        machineName: 'Test Machine',
        agentUrl: 'localhost:4678',
      });

      // Manually expire the code
      const stored = pairingCodes.get('123456')!;
      stored.expiresAt = Date.now() - 1000;

      const result = lookupPairingCode('123456');

      expect(result).toBeNull();
      expect(pairingCodes.has('123456')).toBe(false);
    });
  });
});
