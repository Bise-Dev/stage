/* app-v2.jsx — refined Stage canvas */

const W2 = 1280, H2 = 820;

function AppV2() {
  return (
    <DesignCanvas>
      <DCSection id="workspaces"
                 title="1 · Workspaces"
                 subtitle="Three buckets: branches without a workspace, local-only review, public review on GitHub.">
        <DCArtboard id="v2-workspaces" label="Quiet · grouped" width={W2} height={H2}><V2_Workspaces /></DCArtboard>
      </DCSection>

      <DCSection id="local-review"
                 title="2 · Local review"
                 subtitle="Read your own diff, get a summary, copy/transmit, then open the PR.">
        <DCArtboard id="v2-local" label="Quiet" width={W2} height={H2}><A_LocalReview /></DCArtboard>
      </DCSection>

      <DCSection id="create-pr"
                 title="3 · Create PR"
                 subtitle="Two-step flow: first drag files into order, then write the intro comment for each step.">
        <DCArtboard id="v2-create-order" label="3a · Order files (drag-drop)"  width={W2} height={H2}><V2_CreatePR_Order /></DCArtboard>
        <DCArtboard id="v2-create-intro" label="3b · Write intros (with preview)" width={W2} height={H2}><V2_CreatePR_Intro /></DCArtboard>
      </DCSection>

      <DCSection id="storyline-review"
                 title="4 · Storyline review"
                 subtitle="Reviewer steps through the author's ordered files. Vertical timeline shows progress.">
        <DCArtboard id="v2-story" label="Quiet · with timeline" width={W2} height={H2}><V2_StorylineReview /></DCArtboard>
      </DCSection>

      <DCSection id="publish-review"
                 title="5 · Publish review"
                 subtitle="Summary + review state (approve / comment / request changes), optional GitHub publish.">
        <DCArtboard id="v2-publish" label="Quiet · simple summary" width={W2} height={H2}><V2_PublishReview /></DCArtboard>
      </DCSection>
    </DesignCanvas>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<AppV2 />);
