window.__ModuleLoader__.load({
  id: '@local/dsh-frp-tunnel',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Copy for the tunnel configuration page. */
    const en = {
      title: 'FRP tunnel',
      description: 'Publish this Web UI through your own frps server.',
      unconfigured: 'Not configured — fill in the frps address to start the tunnel.',
      save: 'Save and apply',
      saving: 'Applying…',
      saved: 'Saved',
      failed: 'Save refused',
      reset: 'Reset',
      readOnly: 'This configuration is read-only.',
      basic: 'Server',
      proxy: 'Public entry',
      security: 'Access control',
      advanced: 'Advanced',
      enabled: 'Enable the tunnel',
      enabledHint: 'Stops the relay and frpc when off.',
      serverAddr: 'frps address',
      serverAddrHint: 'Domain or IP of your cloud server.',
      serverPort: 'frps port',
      user: 'frps user prefix',
      userHint: 'Only when frps isolates users.',
      authToken: 'frps auth token',
      tls: 'TLS to frps',
      proxyType: 'Proxy type',
      proxyTypeTcp: 'TCP port',
      proxyTypeHttp: 'HTTP domain',
      remotePort: 'Public port',
      remotePortHint: 'Must be allowed by frps allowPorts.',
      customDomain: 'Custom domain',
      customDomainHint: 'For http type, resolved to frps.',
      subdomain: 'Subdomain',
      subdomainHint: 'For http type, under frps subDomainHost.',
      tunnelUser: 'Gate user',
      tunnelUserHint: 'HTTP Basic user checked before the DSH token.',
      tunnelPassword: 'Gate password',
      tunnelPasswordHint: 'Empty disables the Basic layer.',
      proxyName: 'Proxy name',
      publicUrl: 'Public URL override',
      frpcPath: 'frpc binary',
      mobileLayout: 'Phone layout',
      mobileLayoutHint: 'Inject a phone layout and back/forward support into pages served through the tunnel.',
      p2p: 'Phone app P2P',
      p2pHint: 'The Android app tries a direct P2P connection (xtcp hole punching) first and falls back to frps. Needs the gate password.',
      on: 'Running',
      off: 'Stopped',
    };
    const zh = {
      title: 'FRP 内网穿透',
      description: '把当前 Web 界面通过你自己的 frps 服务器发布到公网。',
      unconfigured: '未配置 —— 填写 frps 地址后隧道才会启动。',
      save: '保存并生效',
      saving: '正在应用…',
      saved: '已保存',
      failed: '保存被拒绝',
      reset: '还原',
      readOnly: '此配置为只读。',
      basic: '服务器',
      proxy: '公网入口',
      security: '访问控制',
      advanced: '高级',
      enabled: '启用隧道',
      enabledHint: '关闭后会停止中继与 frpc。',
      serverAddr: 'frps 地址',
      serverAddrHint: '你的云服务器域名或 IP。',
      serverPort: 'frps 端口',
      user: 'frps 用户前缀',
      userHint: '仅当 frps 启用了用户隔离。',
      authToken: 'frps 鉴权令牌',
      tls: '与 frps 之间启用 TLS',
      proxyType: '代理类型',
      proxyTypeTcp: 'TCP 端口',
      proxyTypeHttp: 'HTTP 域名',
      remotePort: '公网端口',
      remotePortHint: '需要被 frps 的 allowPorts 允许。',
      customDomain: '自定义域名',
      customDomainHint: 'HTTP 模式下解析到 frps 的域名。',
      subdomain: '子域名',
      subdomainHint: 'HTTP 模式下 frps subDomainHost 的子域名。',
      tunnelUser: '入口用户名',
      tunnelUserHint: '在 DSH 令牌之前校验的 HTTP Basic 用户。',
      tunnelPassword: '入口密码',
      tunnelPasswordHint: '留空则不启用 Basic 认证。',
      proxyName: '代理名称',
      publicUrl: '对外地址覆盖',
      frpcPath: 'frpc 可执行文件',
      mobileLayout: '手机端适配',
      mobileLayoutHint: '经隧道访问时注入手机布局与前进后退；电脑浏览器不受影响。',
      p2p: '手机 App P2P 直连',
      p2pHint: '安卓 App 先尝试 P2P 直连（xtcp 打洞），打不通再经 frps 中转。需要设置入口密码。',
      on: '运行中',
      off: '已停止',
    };

    /** Field layout: section grouping, control kind, and whether the host redacts it. */
    const SECTIONS = [
      {
        title: 'basic',
        fields: [
          { key: 'serverAddr', kind: 'text', placeholder: 'frp.example.com' },
          { key: 'serverPort', kind: 'number' },
          { key: 'user', kind: 'text', hint: 'userHint' },
          { key: 'authToken', kind: 'password' },
          { key: 'tls', kind: 'switch' },
        ],
      },
      {
        title: 'proxy',
        fields: [
          { key: 'proxyType', kind: 'select' },
          { key: 'remotePort', kind: 'number', hint: 'remotePortHint' },
          { key: 'customDomain', kind: 'text', hint: 'customDomainHint' },
          { key: 'subdomain', kind: 'text', hint: 'subdomainHint' },
        ],
      },
      {
        title: 'security',
        fields: [
          { key: 'tunnelUser', kind: 'text', hint: 'tunnelUserHint' },
          { key: 'tunnelPassword', kind: 'password', hint: 'tunnelPasswordHint' },
          { key: 'mobileLayout', kind: 'switch', hint: 'mobileLayoutHint' },
          { key: 'p2p', kind: 'switch', hint: 'p2pHint' },
        ],
      },
      {
        title: 'advanced',
        fields: [
          { key: 'proxyName', kind: 'text' },
          { key: 'publicUrl', kind: 'text', placeholder: 'https://dsh.example.com' },
          { key: 'frpcPath', kind: 'text', placeholder: '/opt/homebrew/bin/frpc' },
        ],
      },
    ];
    const ALL = SECTIONS.flatMap((section) => section.fields);

    const styles = {
      card: { display: 'flex', flexDirection: 'column', gap: '20px' },
      section: { display: 'flex', flexDirection: 'column', gap: '12px' },
      sectionTitle: {
        fontSize: '12px',
        fontWeight: 600,
        letterSpacing: '.04em',
        textTransform: 'uppercase',
        color: 'var(--dsw-alias-label-secondary)',
      },
      row: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '24px',
      },
      rowStacked: { display: 'flex', flexDirection: 'column', gap: '4px' },
      label: { fontSize: '14px', lineHeight: '20px', color: 'var(--dsw-alias-label-primary)' },
      hint: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' },
      control: { width: '260px', flex: '0 0 auto' },
      checkbox: { width: '16px', height: '16px', cursor: 'pointer' },
      footer: {
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        borderTop: '.5px solid var(--dsw-alias-border-l2)',
        paddingTop: '16px',
      },
      button: {
        fontSize: '14px',
        lineHeight: '20px',
        padding: '6px 14px',
        borderRadius: '6px',
        border: '.5px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-l2, transparent)',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
      },
      primary: {
        border: '1px solid transparent',
        background: 'var(--dsw-alias-brand-primary, #4d6bfe)',
        color: '#fff',
      },
      notice: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      status: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        fontSize: '12px',
        color: 'var(--dsw-alias-label-secondary)',
      },
      dot: {
        width: '7px',
        height: '7px',
        borderRadius: '50%',
        background: 'var(--dsw-alias-label-secondary)',
      },
      dotOn: { background: '#3fbf6a' },
    };

    const input = (props) =>
      h('input', {
        ...props,
        style: {
          boxSizing: 'border-box',
          width: '100%',
          fontSize: '14px',
          lineHeight: '20px',
          padding: '6px 10px',
          borderRadius: '6px',
          border: '.5px solid var(--dsw-alias-border-l2)',
          background: 'var(--dsw-alias-bg-l1, transparent)',
          color: 'var(--dsw-alias-label-primary)',
        },
      });

    /** Read the current value out of the host form snapshot. */
    function readValue(form) {
      const state = form?.state;
      if (!state) return {};
      const value = state.value ?? state.resolved ?? {};
      return value !== null && typeof value === 'object' ? value : {};
    }

    /** Queue one atomic batch of field writes. */
    function commit(form, draft, baseline, keys) {
      const ops = [];
      for (const key of keys) {
        if (draft[key] === baseline[key]) continue;
        ops.push({ op: 'set', path: [key], value: draft[key] });
      }
      if (ops.length === 0) return Promise.resolve(true);
      return form.mutate(ops, form.state?.revision);
    }

    function Field({ field, draft, setDraft, disabled, t }) {
      const label = t(field.key);
      const hint = field.hint ? t(field.hint) : undefined;
      const value = draft[field.key];

      if (field.kind === 'switch') {
        return h('div', { style: styles.row }, [
          h('div', { key: 'text', style: styles.rowStacked }, [
            h('div', { key: 'l', style: styles.label }, label),
            hint ? h('div', { key: 'h', style: styles.hint }, hint) : null,
          ]),
          h('input', {
            key: 'c',
            type: 'checkbox',
            checked: value === true,
            disabled,
            style: styles.checkbox,
            'aria-label': label,
            onChange: (event) => setDraft(field.key, event.target.checked),
          }),
        ]);
      }

      let control;
      if (field.kind === 'select') {
        control = h(
          'select',
          {
            value: typeof value === 'string' ? value : 'tcp',
            disabled,
            style: { ...styles.button, width: '100%', cursor: disabled ? 'default' : 'pointer' },
            'aria-label': label,
            onChange: (event) => setDraft(field.key, event.target.value),
          },
          [
            h('option', { key: 'tcp', value: 'tcp' }, t('proxyTypeTcp')),
            h('option', { key: 'http', value: 'http' }, t('proxyTypeHttp')),
          ],
        );
      } else if (field.kind === 'number') {
        control = input({
          type: 'number',
          min: 1,
          max: 65535,
          value: value === undefined || value === null ? '' : String(value),
          disabled,
          style: undefined,
          onChange: (event) => {
            const next = event.target.value === '' ? '' : Number(event.target.value);
            setDraft(field.key, next);
          },
        });
      } else {
        control = input({
          type: field.kind === 'password' ? 'password' : 'text',
          value: typeof value === 'string' ? value : '',
          placeholder: field.placeholder,
          disabled,
          autoComplete: 'off',
          onChange: (event) => setDraft(field.key, event.target.value),
        });
      }

      return h('div', { style: styles.row }, [
        h('div', { key: 'text', style: styles.rowStacked }, [
          h('div', { key: 'l', style: styles.label }, label),
          hint ? h('div', { key: 'h', style: styles.hint }, hint) : null,
        ]),
        h('div', { key: 'c', style: styles.control }, control),
      ]);
    }

    function TunnelSettings(props) {
      const { form, t } = props;
      const value = readValue(form);
      const baseline = React.useMemo(() => ({ ...value }), [JSON.stringify(value)]);
      const [draft, setDraftState] = React.useState(baseline);
      const [notice, setNotice] = React.useState(null);
      const [busy, setBusy] = React.useState(false);

      // Follow the host whenever the accepted values change.
      React.useEffect(() => {
        setDraftState(baseline);
      }, [baseline]);

      const setDraft = React.useCallback((key, next) => {
        setDraftState((current) => ({ ...current, [key]: next }));
      }, []);

      if (!form) return h('p', { style: styles.notice }, t('unconfigured'));

      const writable = form.state?.writable !== false;
      const disabled = !writable || busy;

      const onSave = async () => {
        setBusy(true);
        let ok = false;
        try {
          ok = await commit(form, draft, baseline, ALL.map((f) => f.key));
        } catch (_error) {
          ok = false;
        }
        setBusy(false);
        setNotice(ok ? 'saved' : 'failed');
      };

      const running = draft.enabled === true && typeof draft.serverAddr === 'string' && draft.serverAddr !== '';

      return h('div', { style: styles.card }, [
        h('div', { key: 'intro', style: styles.rowStacked }, [
          h('div', { key: 'd', style: styles.label }, t('description')),
          h('div', { key: 's', style: styles.status }, [
            h('span', { key: 'dot', style: { ...styles.dot, ...(running ? styles.dotOn : {}) } }),
            h('span', { key: 'txt' }, running ? t('on') : t('off')),
          ]),
        ]),
        h('div', { key: 'enable', style: styles.section }, [
          h(Field, {
            key: 'enabled',
            field: { key: 'enabled', kind: 'switch', hint: 'enabledHint' },
            draft,
            setDraft,
            disabled,
            t,
          }),
        ]),
        ...SECTIONS.map((section) =>
          h('div', { key: section.title, style: styles.section }, [
            h('div', { key: 'title', style: styles.sectionTitle }, t(section.title)),
            ...section.fields.map((field) =>
              h(Field, { key: field.key, field, draft, setDraft, disabled, t }),
            ),
          ]),
        ),
        h('div', { key: 'footer', style: styles.footer }, [
          h(
            'button',
            {
              key: 'save',
              type: 'button',
              disabled,
              style: { ...styles.button, ...styles.primary, opacity: disabled ? 0.6 : 1 },
              onClick: onSave,
            },
            busy ? t('saving') : t('save'),
          ),
          h(
            'button',
            {
              key: 'reset',
              type: 'button',
              disabled,
              style: styles.button,
              onClick: () => {
                setDraftState(baseline);
                setNotice(null);
              },
            },
            t('reset'),
          ),
          notice === null
            ? null
            : h(
                'span',
                { key: 'notice', style: styles.notice, role: 'status' },
                notice === 'saved' ? t('saved') : t('failed'),
              ),
          writable ? null : h('span', { key: 'ro', style: styles.notice }, t('readOnly')),
        ]),
      ]);
    }

    /** One-liner shown on the bundle row before the page is opened. */
    function TunnelSummary(props) {
      const { form, t } = props;
      const value = readValue(form);
      const parts = [];
      if (value.serverAddr) parts.push(`${value.serverAddr}:${value.serverPort ?? 7000}`);
      if (value.proxyType === 'http') {
        const host = value.customDomain || value.subdomain;
        if (host) parts.push(host);
      } else if (value.remotePort) {
        parts.push(String(value.remotePort));
      }
      const text = parts.length === 0 ? t('unconfigured') : parts.join(' → ');
      return h('span', { style: styles.notice }, text);
    }

    const NS = 'frp-tunnel';
    const ROW_KEY = '@local/dsh-frp-tunnel#frp-tunnel';

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }));
        ctx.slots.inject('plugins.row.config', () =>
          ctx.slots.register(
            {
              name: 'plugins.row.config',
              key: ROW_KEY,
              locale: NS,
            },
            (props) => (props.view === 'summary' ? h(TunnelSummary, props) : h(TunnelSettings, props)),
          ),
        );
      },
    };
  },
});
