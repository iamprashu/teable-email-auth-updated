import {
  
  HttpException, 
  HttpStatus,
  Injectable,
  Logger, 
} from '@nestjs/common'; 
import { useMutation } from '@tanstack/react-query';
import type { HttpError } from '@teable/core';
import { HttpErrorCode } from '@teable/core'; 
import { changeEmail /*, sendChangeEmailCode */ } from '@teable/openapi'; // Removed sendChangeEmailCode
import { useSession } from '@teable/sdk/hooks';
import { Error as ErrorComponent, Spin } from '@teable/ui-lib/base';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Input,
  Label,
} from '@teable/ui-lib/shadcn';
import { toast } from '@teable/ui-lib/shadcn/ui/sonner';
import { useRouter } from 'next/router';
import { useTranslation } from 'next-i18next';
import { useEffect, useState } from 'react';

export function ChangeEmailDialog({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation('common');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newEmail, setNewEmail] = useState('');
  // const [code, setCode] = useState(''); // REMOVED: No longer needed
  const [error, setError] = useState('');
  // const [sendSuccess, setSendSuccess] = useState(false); // REMOVED: No longer needed
  // const [token, setToken] = useState(''); // REMOVED: No longer needed
  const { user } = useSession();
  const router = useRouter();

  useEffect(() => {
    setError('');
  }, [currentPassword, newEmail]); // Simplified dependencies

  // edited from this file
  // const { mutate: sendChangeEmailCodeMutation, isLoading: sendChangeEmailCodeLoading } =
  //   useMutation({
  //     mutationFn: (ro: ISendChangeEmailCodeRo) => {
  //       if (ro.email === user.email) {
  //         throw new Error(t('settings.account.changeEmail.error.invalidSameEmail'));
  //       }
  //       return sendChangeEmailCode(ro);
  //     },
  //     onSuccess: (data) => {
  //       setToken(data.data.token);
  //       setSendSuccess(true);
  //       setTimeout(() => {
  //         setSendSuccess(false);
  //       }, 2000);
  //       toast.success(t('settings.account.changeEmail.success.sendSuccess'));
  //     },
  //     meta: {
  //       preventGlobalError: true,
  //     },
  //     onError: (error: HttpError) => {
  //       if (error.code === HttpErrorCode.CONFLICT) {
  //         setError(t('settings.account.changeEmail.error.invalidConflict'));
  //       } else if (error.code === HttpErrorCode.INVALID_CREDENTIALS) {
  //         setError(t('settings.account.changeEmail.error.invalidPassword'));
  //       } else {
  //         setError(error.message);
  //       }
  //     },
  //   });

  const {
    mutate: changeEmailMutation,
    isLoading: changeEmailLoading,
    isSuccess,
  } = useMutation({
    mutationFn: changeEmail,
    onSuccess: () => {
      toast.success(t('settings.account.changeEmail.success.title'), {
        description: t('settings.account.changeEmail.success.desc'),
      });
      setTimeout(() => {
        router.reload(); // Reload to reflect the email change
      }, 2000);
    },
    meta: {
      preventGlobalError: true,
    },
    onError: (error: HttpError) => {
      if (error.code === HttpErrorCode.CONFLICT) {
        setError(t('settings.account.changeEmail.error.invalidConflict')); 
      } else if (error.code === HttpErrorCode.INVALID_CREDENTIALS) {
        setError(t('settings.account.changeEmail.error.invalidPassword')); 
      }
      else {
        setError(error.message);
      }
    },
  });

  return (
    <Dialog>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="md:w-80">
        <DialogHeader>
          <DialogTitle className="text-center text-sm">
            {t('settings.account.changeEmail.title')}
          </DialogTitle>
          <DialogDescription className="text-center text-xs">
            {t('settings.account.changeEmail.desc')}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground" htmlFor="currentPassword">
              {t('settings.account.changeEmail.current')}
            </Label>
            <Input
              className="h-7"
              id="currentPassword"
              autoComplete="current-password"
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              aria-autocomplete="inline"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground" htmlFor="newEmail">
              {t('settings.account.changeEmail.new')}
            </Label>
            <Input
              className="h-7"
              id="newEmail"
              autoComplete="new-email"
              type="email"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
            />
          </div>
        </div>
        <ErrorComponent className="break-all text-center" error={error} />
        <Button
          className="w-full"
          size={'sm'}
          onClick={() => changeEmailMutation({ newEmail, password: currentPassword })}
          disabled={changeEmailLoading || isSuccess || !newEmail || !currentPassword} 
        >
          {changeEmailLoading && <Spin className="size-4" />}
          {t('actions.confirm')}
        </Button>
      </DialogContent>
    </Dialog>
  );
}