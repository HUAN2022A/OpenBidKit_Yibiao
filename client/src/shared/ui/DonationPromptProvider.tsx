import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { DonationIntent, DonationPromptPayload } from '../types';
import AppDialog from './AppDialog';
import { useToast } from './ToastProvider';

const amountOptions = [
  { value: '10', name: '蜜雪冰城' },
  { value: '50', name: '疯狂星期四' },
  { value: '99', name: '狗不理' },
  { value: '199', name: '海底捞' },
  { value: '699', name: '我养你啊' },
];

function formatHours(milliseconds: number) {
  const value = (Math.max(0, milliseconds) / 3_600_000).toFixed(1);
  return value.endsWith('.0') ? value.slice(0, -2) : value;
}

/** 读取配置并判断离线模式：旧数据缺省按 false，配置读取失败时保持在线行为 */
async function readOfflineMode(): Promise<boolean> {
  try {
    const config = await window.yibiao?.config?.load();
    return Boolean(config && (config as { offline_mode?: boolean }).offline_mode === true);
  } catch {
    return false;
  }
}

/** 全局承接累计使用提醒、创建打赏订单和支付结果确认。 */
export function DonationPromptProvider({ children }: { children: ReactNode }) {
  const { showToast } = useToast();
  const [prompt, setPrompt] = useState<DonationPromptPayload | null>(null);
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('10');
  const [nickname, setNickname] = useState('');
  const [email, setEmail] = useState('');
  const [intent, setIntent] = useState<DonationIntent | null>(null);
  const [orderExpiresAt, setOrderExpiresAt] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [polling, setPolling] = useState(false);
  const [error, setError] = useState('');
  const [offlineMode, setOfflineMode] = useState(false);
  const offlineModeRef = useRef(false);
  const submitRequestId = useRef(0);

  // 离线模式守卫：读取配置，离线时不再发起打赏弹窗与支付相关请求
  useEffect(() => {
    let canceled = false;
    void (async () => {
      const offline = await readOfflineMode();
      if (canceled) return;
      offlineModeRef.current = offline;
      setOfflineMode(offline);
    })();
    return () => {
      canceled = true;
    };
  }, []);

  useEffect(() => {
    const unsubscribePrompt = window.yibiao.donation.onPrompt((payload) => {
      if (offlineModeRef.current) {
        return; // 离线模式：静默跳过打赏弹窗
      }
      setPrompt(payload);
      setOpen(true);
      setError('');
    });
    const unsubscribePaid = window.yibiao.donation.onPaid(() => {
      submitRequestId.current += 1;
      setOpen(false);
      setIntent(null);
      setOrderExpiresAt(0);
      setAmount('10');
      setNickname('');
      setEmail('');
      setSubmitting(false);
      setPolling(false);
      setError('');
      showToast('感谢支持，之后不会再主动打扰你。', 'success', { title: '打赏成功' });
    });
    return () => {
      unsubscribePrompt();
      unsubscribePaid();
    };
  }, [showToast]);

  useEffect(() => {
    const merchantOrderNo = intent?.merchant_order_no;
    if (offlineMode || !merchantOrderNo || ['paid', 'failed', 'closed'].includes(intent.status || '') || (orderExpiresAt > 0 && Date.now() >= orderExpiresAt)) return undefined;

    let stopped = false;
    let timer = 0;
    const pollOrder = async () => {
      setPolling(true);
      try {
        const order = await window.yibiao.donation.getOrderStatus(merchantOrderNo);
        if (stopped) return;
        setIntent((current) => current ? { ...current, status: order.status } : current);
        if (order.status === 'failed' || order.status === 'closed') {
          setError('');
        } else {
          setError('');
        }
      } catch (pollError) {
        if (!stopped) {
          setError(pollError instanceof Error ? pollError.message : '查询支付状态失败');
        }
      } finally {
        if (!stopped) {
          setPolling(false);
          timer = window.setTimeout(pollOrder, 3000);
        }
      }
    };

    timer = window.setTimeout(pollOrder, 1500);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [intent?.merchant_order_no, intent?.status, orderExpiresAt, offlineMode]);

  useEffect(() => {
    const merchantOrderNo = intent?.merchant_order_no;
    if (offlineMode || !merchantOrderNo || !orderExpiresAt || ['paid', 'failed', 'closed'].includes(intent.status || '')) return undefined;

    let stopped = false;
    const expireOrder = async () => {
      try {
        const order = await window.yibiao.donation.finalizeOrderStatus(merchantOrderNo);
        if (stopped || order.status === 'paid') return;
      } catch {
        // Main 会继续后台确认；前台按渠道有效期停止展示二维码。
      }
      if (!stopped) {
        setIntent((current) => current ? { ...current, status: 'closed' } : current);
        setPolling(false);
        setError('');
      }
    };

    const timer = window.setTimeout(expireOrder, Math.max(0, orderExpiresAt - Date.now()));
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [intent?.merchant_order_no, intent?.status, orderExpiresAt, offlineMode]);

  const closeDialog = () => {
    submitRequestId.current += 1;
    setOpen(false);
    setIntent(null);
    setOrderExpiresAt(0);
    setAmount('10');
    setNickname('');
    setEmail('');
    setPolling(false);
    setSubmitting(false);
    setError('');
  };

  const dismissForever = async () => {
    try {
      await window.yibiao.donation.dismissPrompts();
      closeDialog();
      showToast('已关闭打赏提醒，之后不会再打扰你。', 'success');
    } catch {
      closeDialog();
    }
  };

  const submitDonation = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (offlineMode) {
      setError('离线模式已开启，暂不支持在线打赏。');
      return; // 离线模式：不请求打赏接口，仅展示离线提示
    }
    const requestId = ++submitRequestId.current;
    setSubmitting(true);
    setError('');
    try {
      const result = await window.yibiao.donation.createTip({
        amount,
        ...(nickname.trim() ? { nickname: nickname.trim() } : {}),
        ...(email.trim() ? { email: email.trim() } : {}),
      });
      if (result.channel !== 'xorpay' || !result.merchant_order_no || !result.qr_image_url) {
        throw new Error('当前打赏通道暂不支持应用内扫码支付');
      }
      if (submitRequestId.current !== requestId) return;
      setIntent(result);
      setOrderExpiresAt(Date.now() + Math.max(60, Number(result.expires_in) || 7200) * 1000);
    } catch (submitError) {
      if (submitRequestId.current === requestId) {
        setError(submitError instanceof Error ? submitError.message : '创建打赏订单失败');
      }
    } finally {
      if (submitRequestId.current === requestId) setSubmitting(false);
    }
  };

  const resetOrder = () => {
    setIntent(null);
    setOrderExpiresAt(0);
    setPolling(false);
    setError('');
  };

  return (
    <>
      {children}
      <AppDialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) closeDialog();
        }}
        kicker="支持开源"
        title="请作者吃顿饭吧"
        description={prompt ? (
          <>您已累计使用铸标 <strong>{formatHours(prompt.accumulatedRuntimeMs)} 小时</strong>，累计下载 <strong>{prompt.wordExportClicks} 次</strong>标书。开发不易，在线乞讨，请作者吃顿饭吧。</>
        ) : undefined}
        cardClassName="donation-dialog-card"
      >
        {offlineMode ? (
          <div className="donation-expired-panel">
            <strong>离线模式已开启</strong>
            <p>当前处于离线模式，暂不支持在线打赏。感谢你的支持！</p>
          </div>
        ) : intent && ['failed', 'closed'].includes(intent.status || '') ? (
          <div className="donation-expired-panel">
            <strong>二维码已失效</strong>
            <p>旧订单已停止展示，请重新选择金额生成新的二维码。</p>
          </div>
        ) : intent?.qr_image_url ? (
          <div className="donation-payment-panel">
            <div className="donation-qr-wrap">
              <img src={intent.qr_image_url} alt="微信打赏二维码" />
            </div>
            <div className="donation-payment-copy">
              <span>微信扫码支付</span>
              <strong>¥{intent.amount || amount}</strong>
              <p>{polling ? '正在等待支付结果...' : '二维码生成成功，请使用微信扫码。'}</p>
              <small>订单号：{intent.merchant_order_no}</small>
            </div>
          </div>
        ) : (
          <form id="donation-prompt-form" className="donation-form" onSubmit={submitDonation}>
            <fieldset className="donation-amount-fieldset">
              <legend>今天想请作者吃什么？</legend>
              <div className="donation-amount-grid">
                {amountOptions.map((option) => (
                  <label className={`donation-amount-option${amount === option.value ? ' is-selected' : ''}`} key={option.value}>
                    <input
                      type="radio"
                      name="donation-amount"
                      value={option.value}
                      checked={amount === option.value}
                      onChange={(event) => setAmount(event.target.value)}
                    />
                    <span>{option.name}</span>
                    <strong>¥{option.value}</strong>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="donation-identity-grid">
              <label>
                <span>昵称 <small>选填，用于鸣谢</small></span>
                <input type="text" maxLength={80} value={nickname} onChange={(event) => setNickname(event.target.value)} placeholder="怎么称呼你" />
              </label>
              <label>
                <span>邮箱 <small>选填，用于关联账号</small></span>
                <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" />
              </label>
            </div>
          </form>
        )}

        {error ? <p className="donation-error" role="alert">{error}</p> : null}

        <div className="donation-dialog-actions">
          <button type="button" className="text-button" onClick={() => { void dismissForever(); }}>不再提醒</button>
          <button type="button" className="secondary-action" onClick={closeDialog}>暂时不用</button>
          {offlineMode ? null : intent ? (
            <button type="button" className="primary-action" onClick={resetOrder}>重新选择</button>
          ) : (
            <button type="submit" form="donation-prompt-form" className="primary-action donation-submit" disabled={submitting}>
              {submitting ? '正在生成二维码...' : `微信扫码打赏 ¥${amount}`}
            </button>
          )}
        </div>
      </AppDialog>
    </>
  );
}

export default DonationPromptProvider;
