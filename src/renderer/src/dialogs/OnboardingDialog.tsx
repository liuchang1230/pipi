import { useEffect, useRef, useState } from "react";

type Step = 0 | 1 | 2;

interface OnboardingDialogProps {
  open: boolean;
  onConfigureModel: () => void;
  onAddLocalProject: () => Promise<boolean>;
  onConnectRemote: () => void;
  onSkip: () => void;
  onComplete: () => void;
}

const STEPS = ["配置模型", "选择项目", "开始使用"];

/**
 * Small first-run guide. It deliberately delegates every real action to the
 * existing dialogs/actions instead of creating a second configuration path.
 */
export function OnboardingDialog({
  open,
  onConfigureModel,
  onAddLocalProject,
  onConnectRemote,
  onSkip,
  onComplete,
}: OnboardingDialogProps) {
  const [step, setStep] = useState<Step>(0);
  const [addingProject, setAddingProject] = useState(false);
  const primaryRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    setStep(0);
    setAddingProject(false);
    requestAnimationFrame(() => primaryRef.current?.focus());
  }, [open]);

  if (!open) return null;

  const addLocalProject = async () => {
    setAddingProject(true);
    try {
      if (await onAddLocalProject()) onComplete();
    } finally {
      setAddingProject(false);
    }
  };

  return (
    <div className="dialog-overlay onboarding-overlay" role="presentation">
      <div className="dialog onboarding-dialog" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
        <div className="onboarding-topline">
          <div className="onboarding-brand">pipi</div>
          <button className="onboarding-skip" onClick={onSkip}>跳过引导</button>
        </div>
        <div className="dialog-title" id="onboarding-title">开始你的 AI 编程工作台</div>
        <div className="onboarding-steps" aria-label="引导步骤">
          {STEPS.map((label, index) => (
            <button
              key={label}
              className={`onboarding-step${step === index ? " active" : ""}${step > index ? " done" : ""}`}
              onClick={() => setStep(index as Step)}
            >
              <span>{index + 1}</span>{label}
            </button>
          ))}
        </div>

        <div className="dialog-body onboarding-body">
          {step === 0 && (
            <>
              <h3>先配置一个模型</h3>
              <p>pipi 使用你自己的 API Key。可通过预设快速配置 DeepSeek、Kimi、智谱、硅基流动，或填写任意 OpenAI 兼容端点。</p>
              <button ref={primaryRef} className="btn btn-primary" onClick={onConfigureModel}>配置模型</button>
              <button className="onboarding-text-action" onClick={() => setStep(1)}>我稍后配置，继续</button>
            </>
          )}
          {step === 1 && (
            <>
              <h3>选择代码项目</h3>
              <p>从本机打开项目，或连接 SSH / WSL 后在远程环境中运行 pi。已有项目也随时可从左侧栏添加。</p>
              <div className="onboarding-choice-row">
                <button className="btn btn-primary" onClick={() => void addLocalProject()} disabled={addingProject}>
                  {addingProject ? "正在选择…" : "打开本地项目"}
                </button>
                <button className="btn" onClick={onConnectRemote}>连接 SSH / WSL</button>
              </div>
              <button className="onboarding-text-action" onClick={() => setStep(2)}>暂时不选项目</button>
            </>
          )}
          {step === 2 && (
            <>
              <h3>可以开始了</h3>
              <p>选择项目后，在中间区域输入任务；pipi 会保留会话、终端和文件改动，方便你随时继续工作。</p>
              <div className="onboarding-tip">提示：从左侧栏的 <strong>+</strong> 可随时添加本地项目或远程服务器。</div>
              <button className="btn btn-primary" onClick={onComplete}>进入工作台</button>
            </>
          )}
        </div>

        <div className="dialog-actions onboarding-actions">
          {step > 0 && <button className="btn" onClick={() => setStep((step - 1) as Step)}>上一步</button>}
          {step < 2 && <button className="btn" onClick={() => setStep((step + 1) as Step)}>下一步</button>}
        </div>
      </div>
    </div>
  );
}
