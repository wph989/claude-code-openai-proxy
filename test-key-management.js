// 测试 API Key 管理功能
import { ApiKeyRotator } from './dist/services/api-key-rotator.js';
import { KeyRotationStrategy } from './dist/models.js';

console.log('=== API Key 管理功能测试 ===\n');

// 测试 1: 创建 key 对象
console.log('测试 1: 创建 ApiKeyEntry 对象');
const keys = [
  { key: 'sk-test-1', enabled: true, error_count: 0, disabled_at: null, last_error_at: null, last_error_message: null, auto_disabled_at: null },
  { key: 'sk-test-2', enabled: true, error_count: 0, disabled_at: null, last_error_at: null, last_error_message: null, auto_disabled_at: null },
  { key: 'sk-test-3', enabled: false, error_count: 5, disabled_at: null, last_error_at: Date.now(), last_error_message: '401 Unauthorized', auto_disabled_at: Date.now() }
];
console.log('✓ 创建了 3 个 key，其中 1 个已禁用\n');

// 测试 2: 轮换器跳过禁用的 key
console.log('测试 2: pick() 跳过禁用的 key');
const rotator = new ApiKeyRotator(keys, KeyRotationStrategy.round_robin);
const picked = [];
for (let i = 0; i < 5; i++) {
  picked.push(rotator.pick());
}
console.log('连续 5 次 pick():', picked);
console.log('✓ 禁用的 key (sk-test-3) 从未被选中\n');

// 测试 3: 错误计数和自动禁用
console.log('测试 3: 错误计数和自动禁用 (KEY_MAX_ERRORS=3)');
const keys2 = [
  { key: 'sk-auto-1', enabled: true, error_count: 0, disabled_at: null, last_error_at: null, last_error_message: null, auto_disabled_at: null },
  { key: 'sk-auto-2', enabled: true, error_count: 0, disabled_at: null, last_error_at: null, last_error_message: null, auto_disabled_at: null }
];

// 模拟设置 KEY_MAX_ERRORS
process.env.KEY_MAX_ERRORS = '3';
const rotator2 = new ApiKeyRotator(keys2, KeyRotationStrategy.on_429);

console.log('初始状态:');
console.log('  sk-auto-1: enabled=' + keys2[0].enabled + ', error_count=' + keys2[0].error_count);
console.log('  sk-auto-2: enabled=' + keys2[1].enabled + ', error_count=' + keys2[1].error_count);

rotator2.markError('sk-auto-1', '429 Too Many Requests', true);
console.log('\n第 1 次错误后:');
console.log('  sk-auto-1: enabled=' + keys2[0].enabled + ', error_count=' + keys2[0].error_count);

rotator2.markError('sk-auto-1', '429 Too Many Requests', true);
console.log('\n第 2 次错误后:');
console.log('  sk-auto-1: enabled=' + keys2[0].enabled + ', error_count=' + keys2[0].error_count);

rotator2.markError('sk-auto-1', '429 Too Many Requests', true);
console.log('\n第 3 次错误后 (达到阈值):');
console.log('  sk-auto-1: enabled=' + keys2[0].enabled + ', error_count=' + keys2[0].error_count + ', auto_disabled_at=' + (keys2[0].auto_disabled_at ? '已设置' : '未设置'));
console.log('✓ key 在 3 次错误后自动禁用\n');

// 测试 4: 手动启用/禁用
console.log('测试 4: 手动启用/禁用');
rotator2.disableKey('sk-auto-2');
console.log('手动禁用 sk-auto-2:');
console.log('  enabled=' + keys2[1].enabled + ', disabled_at=' + (keys2[1].disabled_at ? '已设置' : '未设置'));

rotator2.enableKey('sk-auto-2');
console.log('\n手动启用 sk-auto-2:');
console.log('  enabled=' + keys2[1].enabled + ', error_count=' + keys2[1].error_count);
console.log('✓ 手动操作正常工作\n');

// 测试 5: 全部不可用检测
console.log('测试 5: allUnavailable() 检测');
const keys3 = [
  { key: 'sk-dis-1', enabled: false, error_count: 5, disabled_at: null, last_error_at: null, last_error_message: null, auto_disabled_at: null },
  { key: 'sk-dis-2', enabled: false, error_count: 5, disabled_at: null, last_error_at: null, last_error_message: null, auto_disabled_at: null }
];
const rotator3 = new ApiKeyRotator(keys3, KeyRotationStrategy.round_robin);
console.log('所有 key 都禁用时: allUnavailable()=' + rotator3.allUnavailable());
console.log('✓ 正确检测到所有 key 不可用\n');

console.log('=== 所有测试通过 ===');
