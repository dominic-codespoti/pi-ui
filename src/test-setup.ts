import '@testing-library/jest-dom/vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Never read/write the real ~/.pi/agent JWT secret during unit tests.
process.env.PI_UI_JWT_SECRET_FILE = join(tmpdir(), 'pi-ui-jwt-secret-test');
