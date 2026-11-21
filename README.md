# 青玉桌

百家乐、骰宝各自运行连续牌局。两桌使用同一个积分账户，余额和已下注战绩由服务器保存，每天北京时间 00:00 将可用积分重置为 1,000。下注必须在封盘前确认，未确认的选择不会扣分。空局照常开奖。

## 启动

需要 Node.js 22 或更高版本，无需安装依赖。

```sh
npm test
npm start
```

本机打开 `http://127.0.0.1:3080`。服务默认每 30 秒开奖，开奖前 3 秒封盘。设 `ROUND_INTERVAL_SECONDS=20` 可切换至 20 秒。两张桌均由服务器计时，即使无人连接也开放并开奖。

## 部署到 gamble.zeldati.cn

使用 `jade-room-live.zip`，或检出仓库的新版源码。部署根目录需要同时包含 `server/`、`dist/` 和 `package.json`。旧版 `jade-room-v1.zip` 是此前的静态版。

让 systemd 或同类服务管理器以普通服务账户执行 `node server/index.js`，工作目录设为部署根目录，配置开机启动并在进程异常退出时重启。保留 `JADE_STATE_FILE` 指定的数据文件及其目录，服务账户需要写入权限。默认位置为工作目录的 `server-data/state.json`，可设为发布目录之外的绝对路径，避免更新时覆盖持久化数据。同一个状态文件只由一个服务实例使用。

保留域名现有的 HTTPS 和站点访问认证。在现有 HTTPS 虚拟主机中，把静态站点的根路径改为以下反向代理，原有认证继续覆盖页面和 API。如果认证指令原先写在 `location /` 内，保留 `auth_basic` 和 `auth_basic_user_file`。

```nginx
location / {
    proxy_pass http://127.0.0.1:3080;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 60s;
}
```

验证 Nginx 配置后重载。登录网站，确认两张桌都显示倒计时，下注确认后可以关闭网页；下一次打开仍可看到该局结算。服务器积分从 1,000 起算，第一版的浏览器本地记录继续保留在原浏览器存储中。
