import { createContext, useContext } from 'react';
import { useAuth } from './auth.jsx';

// Minimal i18n: a flat dictionary keyed by string id, with {var} interpolation.
// Language comes from the user's saved preference (auth context). English is
// the source of truth and the fallback for any missing key.
const STRINGS = {
  en: {
    'nav.dashboard': 'Dashboard', 'nav.servers': 'Servers', 'nav.functions': 'Functions',
    'nav.transcoders': 'Transcoders', 'nav.distribution': 'Distribution', 'nav.users': 'Users',
    'nav.roles': 'Roles', 'nav.zabbix': 'Zabbix', 'nav.settings': 'Settings', 'nav.audit': 'Audit',
    'nav.profile': 'Profile',
    'action.save': 'Save', 'action.cancel': 'Cancel', 'action.apply': 'Apply',
    'action.refresh': 'Refresh', 'action.logout': 'Log out',
    'profile.title': 'Profile settings',
    'profile.sub': 'Your personal panel preferences and account security.',
    'profile.appearance': 'Appearance',
    'profile.theme': 'Theme', 'profile.theme.system': 'System', 'profile.theme.dark': 'Dark', 'profile.theme.light': 'Light',
    'profile.language': 'Language',
    'profile.funcWidth': 'Function dialog width',
    'profile.width.narrow': 'Narrow', 'profile.width.default': 'Default', 'profile.width.wide': 'Wide', 'profile.width.xwide': 'Extra wide',
    'profile.security': 'Security',
    'profile.changePassword': 'Change password',
    'profile.currentPassword': 'Current password',
    'profile.newPassword': 'New password',
    'profile.confirmPassword': 'Confirm new password',
    'profile.passwordChanged': 'Password changed.',
    'profile.passwordMismatch': 'Passwords do not match.',
    'profile.saved': 'Preferences saved.',
    'profile.2fa': 'Two-factor authentication',
    'twofa.desc': 'Protect your account with a time-based code from an authenticator app.',
    'twofa.setup': 'Set up 2FA',
    'twofa.scan': 'Scan this QR code with Google Authenticator, Authy, 1Password, etc.',
    'twofa.manual': 'Or enter this key manually:',
    'twofa.enterCode': 'Authentication code',
    'twofa.enable': 'Enable 2FA',
    'twofa.enabled': '2FA is enabled',
    'twofa.disable': 'Disable 2FA',
    'twofa.backupRemaining': '{n} backup codes left',
    'twofa.backupTitle': 'Save your backup codes',
    'twofa.backupHint': 'Each code works once if you lose your device. Store them somewhere safe — they will not be shown again.',
    'twofa.copy': 'Copy',
    'twofa.saved': 'I saved them',
    'login.2faTitle': 'Two-factor authentication',
    'login.2faPrompt': 'Enter the 6-digit code from your authenticator app (or a backup code).',
    'login.verify': 'Verify',
  },
  ru: {
    'nav.dashboard': 'Панель', 'nav.servers': 'Серверы', 'nav.functions': 'Функции',
    'nav.transcoders': 'Транскодеры', 'nav.distribution': 'Раздача', 'nav.users': 'Пользователи',
    'nav.roles': 'Роли', 'nav.zabbix': 'Zabbix', 'nav.settings': 'Настройки', 'nav.audit': 'Аудит',
    'nav.profile': 'Профиль',
    'action.save': 'Сохранить', 'action.cancel': 'Отмена', 'action.apply': 'Применить',
    'action.refresh': 'Обновить', 'action.logout': 'Выйти',
    'profile.title': 'Настройки профиля',
    'profile.sub': 'Персональные настройки панели и безопасность аккаунта.',
    'profile.appearance': 'Оформление',
    'profile.theme': 'Тема', 'profile.theme.system': 'Системная', 'profile.theme.dark': 'Тёмная', 'profile.theme.light': 'Светлая',
    'profile.language': 'Язык',
    'profile.funcWidth': 'Ширина окна функций',
    'profile.width.narrow': 'Узкое', 'profile.width.default': 'Обычное', 'profile.width.wide': 'Широкое', 'profile.width.xwide': 'Очень широкое',
    'profile.security': 'Безопасность',
    'profile.changePassword': 'Сменить пароль',
    'profile.currentPassword': 'Текущий пароль',
    'profile.newPassword': 'Новый пароль',
    'profile.confirmPassword': 'Повторите новый пароль',
    'profile.passwordChanged': 'Пароль изменён.',
    'profile.passwordMismatch': 'Пароли не совпадают.',
    'profile.saved': 'Настройки сохранены.',
    'profile.2fa': 'Двухфакторная аутентификация',
    'twofa.desc': 'Защитите аккаунт одноразовым кодом из приложения-аутентификатора.',
    'twofa.setup': 'Настроить 2FA',
    'twofa.scan': 'Отсканируйте QR-код в Google Authenticator, Authy, 1Password и т.п.',
    'twofa.manual': 'Или введите ключ вручную:',
    'twofa.enterCode': 'Код подтверждения',
    'twofa.enable': 'Включить 2FA',
    'twofa.enabled': '2FA включена',
    'twofa.disable': 'Отключить 2FA',
    'twofa.backupRemaining': 'Осталось резервных кодов: {n}',
    'twofa.backupTitle': 'Сохраните резервные коды',
    'twofa.backupHint': 'Каждый код работает один раз, если потеряете устройство. Сохраните их надёжно — снова показаны не будут.',
    'twofa.copy': 'Копировать',
    'twofa.saved': 'Я сохранил',
    'login.2faTitle': 'Двухфакторная аутентификация',
    'login.2faPrompt': 'Введите 6-значный код из приложения-аутентификатора (или резервный код).',
    'login.verify': 'Подтвердить',
  },
};

const I18nCtx = createContext({ t: (k) => k, lang: 'en' });

export function I18nProvider({ children }) {
  const { user } = useAuth();
  const lang = user?.preferences?.lang || 'en';
  const t = (key, vars) => {
    let str = (STRINGS[lang] && STRINGS[lang][key]) || STRINGS.en[key] || key;
    if (vars) for (const [k, v] of Object.entries(vars)) str = str.replace(`{${k}}`, v);
    return str;
  };
  return <I18nCtx.Provider value={{ t, lang }}>{children}</I18nCtx.Provider>;
}
export const useI18n = () => useContext(I18nCtx);
