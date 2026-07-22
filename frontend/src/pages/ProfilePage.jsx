import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useTheme } from '../theme.jsx';
import { useI18n } from '../i18n.jsx';
import Select from '../components/Select.jsx';

export default function ProfilePage() {
  const { user, refreshUser } = useAuth();
  const { setTheme } = useTheme();
  const { t } = useI18n();

  const [prefs, setPrefs] = useState(user?.preferences || { theme: 'system', lang: 'en', functionModalWidth: 'default' });
  const [savedMsg, setSavedMsg] = useState('');
  const [pwCur, setPwCur] = useState('');
  const [pwNew, setPwNew] = useState('');
  const [pwConf, setPwConf] = useState('');
  const [pwMsg, setPwMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (user?.preferences) setPrefs(user.preferences); }, [user]);

  const savePref = async (patch) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    if (patch.theme) setTheme(patch.theme); // instant visual feedback
    try {
      await api('/auth/me/preferences', { method: 'PUT', body: patch });
      await refreshUser();
      setSavedMsg(t('profile.saved'));
      setTimeout(() => setSavedMsg(''), 1500);
    } catch (e) { setSavedMsg(e.message); }
  };

  const changePassword = async () => {
    setPwMsg(null);
    if (pwNew !== pwConf) { setPwMsg({ ok: false, text: t('profile.passwordMismatch') }); return; }
    setBusy(true);
    try {
      await api('/auth/me/password', { method: 'POST', body: { currentPassword: pwCur, newPassword: pwNew } });
      setPwCur(''); setPwNew(''); setPwConf('');
      setPwMsg({ ok: true, text: t('profile.passwordChanged') });
    } catch (e) { setPwMsg({ ok: false, text: e.message }); }
    finally { setBusy(false); }
  };

  return (
    <div>
      <h1>{t('profile.title')}</h1>
      <div className="sub">{t('profile.sub')}</div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>{t('profile.appearance')}</h2>
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
          <div>
            <label>{t('profile.theme')}</label>
            <Select value={prefs.theme} onChange={v => savePref({ theme: v })}
                    options={[
                      { value: 'system', label: t('profile.theme.system') },
                      { value: 'dark', label: t('profile.theme.dark') },
                      { value: 'light', label: t('profile.theme.light') },
                    ]} />
          </div>
          <div>
            <label>{t('profile.language')}</label>
            <Select value={prefs.lang} onChange={v => savePref({ lang: v })}
                    options={[{ value: 'en', label: 'English' }, { value: 'ru', label: 'Русский' }]} />
          </div>
          <div>
            <label>{t('profile.funcWidth')}</label>
            <Select value={prefs.functionModalWidth} onChange={v => savePref({ functionModalWidth: v })}
                    options={[
                      { value: 'narrow', label: t('profile.width.narrow') },
                      { value: 'default', label: t('profile.width.default') },
                      { value: 'wide', label: t('profile.width.wide') },
                      { value: 'xwide', label: t('profile.width.xwide') },
                    ]} />
          </div>
        </div>
        {savedMsg && <div className="hint" style={{ marginTop: 10 }}><span className="lamp on" />{savedMsg}</div>}
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>{t('profile.security')}</h2>
        <div style={{ maxWidth: 380 }}>
          <label>{t('profile.currentPassword')}</label>
          <input type="password" value={pwCur} onChange={e => setPwCur(e.target.value)} />
          <label>{t('profile.newPassword')}</label>
          <input type="password" value={pwNew} onChange={e => setPwNew(e.target.value)} />
          <label>{t('profile.confirmPassword')}</label>
          <input type="password" value={pwConf} onChange={e => setPwConf(e.target.value)} />
          <button className="primary" style={{ marginTop: 12 }} disabled={busy || !pwCur || !pwNew || !pwConf}
                  onClick={changePassword}>{t('profile.changePassword')}</button>
          {pwMsg && (pwMsg.ok
            ? <div className="hint" style={{ marginTop: 10 }}><span className="lamp on" />{pwMsg.text}</div>
            : <div className="error-box">{pwMsg.text}</div>)}
        </div>
        <div style={{ marginTop: 18, opacity: .6 }}>
          <label>{t('profile.2fa')}</label>
          <div className="hint">{t('profile.2fa.soon')}</div>
        </div>
      </div>
    </div>
  );
}
