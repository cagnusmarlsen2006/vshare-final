'use strict';

/**
 * Cross-platform "offline" start (works the same in PowerShell, cmd and bash):
 *   npm run start:mock
 * Uses local mock storage in .mock_storage/ instead of Cloudinary.
 */
process.env.STORAGE = 'mock';
require('../src/server');
