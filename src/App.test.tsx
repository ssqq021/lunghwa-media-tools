import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';

afterEach(cleanup);

describe('tool mode loading', () => {
  it.each([
    ['背景抠图工具', '已切换到图片背景抠图功能，请上传图片并点选背景颜色。'],
    ['图片尺寸工具', '已切换到图片尺寸工具，请上传图片并设置目标尺寸。'],
    ['图片压缩工具', '已切换到图片压缩工具，请上传图片并设置压缩参数。'],
  ])('loads %s on demand and keeps its status in sync', async (toolName, expectedStatus) => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: toolName }));

    expect(await screen.findByRole('heading', { level: 1, name: new RegExp(toolName) })).toBeTruthy();
    expect(await screen.findByText('拖放图片到这里')).toBeTruthy();
    expect(screen.getByText(expectedStatus)).toBeTruthy();
  });
});
