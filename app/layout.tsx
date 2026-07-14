import type { Metadata } from 'next';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import '../src/styles.css';

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get('host') ?? 'lunghwa.cn';
  const protocol = host.startsWith('localhost') ? 'http' : 'https';
  const metadataBase = new URL(`${protocol}://${host}`);
  const socialImage = new URL('/og.png', metadataBase).toString();

  return {
    metadataBase,
    title: '视频转序列帧表',
    description: '在浏览器本地完成视频抽帧、裁剪、抠像和序列帧资源导出，视频无需上传服务器。',
    openGraph: {
      title: '视频转序列帧表',
      description: '浏览器本地处理，视频无需上传。',
      type: 'website',
      url: metadataBase,
      images: [{ url: socialImage, width: 1731, height: 909 }],
    },
    twitter: {
      card: 'summary_large_image',
      title: '视频转序列帧表',
      description: '浏览器本地处理，视频无需上传。',
      images: [socialImage],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
