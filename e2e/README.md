# 浏览器回放测试

浏览器测试使用仅监听本机回环地址的固定响应模型，不访问外部模型服务，也不复用开发数据。

首次运行先安装与当前 Playwright 版本匹配的 Chromium：

```sh
pnpm test:e2e:install
```

之后运行：

```sh
pnpm test:e2e
```

若本机已安装 Google Chrome，也可以显式复用它：

```sh
WANXIANG_E2E_BROWSER_CHANNEL=chrome pnpm test:e2e
```
