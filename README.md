# 青玉桌

百家乐、骰宝在服务端连续开局。用户自行填写用户名和密码即可注册，无需邮箱。注册当天发 1,000 积分，此后每个北京时间自然日再发 1,000 积分，余额累积，离线期间的每日积分也照常累计。下注档位为 10、25、50、100、200、500 积分。空局照常开奖。

## 启动与管理员

需要 Node.js 22 或更高版本，无需安装依赖。

```sh
npm test
npm start
```

本机打开 `http://127.0.0.1:3080`。服务默认每 30 秒开奖，开奖前 3 秒封盘。设 `ROUND_INTERVAL_SECONDS=20` 可切换至 20 秒。

首次启动时为服务配置 `JADE_ADMIN_USERNAME` 和 `JADE_ADMIN_PASSWORD_FILE`。后者指向仅服务账号可读的密码文件，密码至少 8 个字符。服务在数据库中还没有管理员时自动建立该账户。管理员登录后，点「积分管理」，选一个已注册账户，填写正整数积分并确认。后台会记录发放时间、管理员、收款账户和金额。

升级时沿用现有 `JADE_STATE_FILE`，让服务自动迁移原有服务器共享积分、战绩和已确认的未结算下注到首个管理员账号。新注册的账号独立记账。升级前备份该文件。

## 部署到 gamble.zeldati.cn

使用 `jade-room-accounts.zip`，或检出仓库的新版源码。部署目录需要同时包含 `server/`、`dist/` 和 `package.json`。

让 systemd 或同类服务管理器以普通服务账户执行 `node server/index.js`，工作目录设为部署根目录，配置开机启动及失败重启。保留 `JADE_STATE_FILE` 指定的数据文件及其目录，服务账户需要写入权限。默认位置为工作目录的 `server-data/state.json`，可以配置为发布目录之外的持久路径。同一份状态文件由一个服务进程独占。

保留域名现有的 HTTPS。在现有 HTTPS 虚拟主机沿用以下反向代理配置。设置服务环境变量 `JADE_TRUST_PROXY=1` 后，登录限速会使用 Nginx 写入的真实客户端 IP。

```nginx
location / {
    proxy_pass http://127.0.0.1:3080;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 60s;
}
```

验证应用注册及管理员登录后，如需对用户开放自助注册，可仅在这个站点的 `location /` 设 `auth_basic off;`，让用户用新版账号登录。未登录访问受保护的游戏 API 会返回 401。验证 Nginx 配置后再重载。
