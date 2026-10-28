import { Mail } from 'lucide-react';
import googleIcon from './assets/google-sign-in.svg';
import githubIcon from './assets/github-sign-in.svg';

export function ProviderIcon({ id }: { id: string }) {
  if (id === 'google')
    return <img className="provider-icon" src={googleIcon} alt="" aria-hidden="true" />;
  if (id === 'github')
    return (
      <img
        className="provider-icon provider-icon-github"
        src={githubIcon}
        alt=""
        aria-hidden="true"
      />
    );
  if (id === 'yandex')
    return (
      <span className="provider-icon provider-icon-yandex" aria-hidden="true">
        Я
      </span>
    );
  return (
    <span className="provider-icon provider-icon-mail" aria-hidden="true">
      <Mail />
    </span>
  );
}
