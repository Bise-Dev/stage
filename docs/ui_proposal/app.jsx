/* app.jsx — DesignCanvas wiring for Stage screens */

const W = 1280, H = 820;

function App() {
  return (
    <DesignCanvas>
      <DCSection id="workspaces" title="1 · Workspaces overview" subtitle="Branches as first-class entities — list, search, open, create.">
        <DCArtboard id="a-workspaces" label="A · Quiet"        width={W} height={H}><A_Workspaces /></DCArtboard>
        <DCArtboard id="b-workspaces" label="B · Source list"  width={W} height={H}><B_Workspaces /></DCArtboard>
      </DCSection>

      <DCSection id="local-review" title="2 · Local review" subtitle="Read your own diff, get a summary, copy/transmit, then open the PR.">
        <DCArtboard id="a-local"      label="A · Quiet"        width={W} height={H}><A_LocalReview /></DCArtboard>
        <DCArtboard id="b-local"      label="B · Source list"  width={W} height={H}><B_LocalReview /></DCArtboard>
      </DCSection>

      <DCSection id="create-pr" title="3 · Create PR" subtitle="Title + description, plus the storyline composer — drag files into order and write an intro for each step.">
        <DCArtboard id="a-create"     label="A · Quiet"        width={W} height={H}><A_CreatePR /></DCArtboard>
        <DCArtboard id="b-create"     label="B · Source list"  width={W} height={H}><B_CreatePR /></DCArtboard>
      </DCSection>

      <DCSection id="storyline-review" title="4 · Storyline review" subtitle="Reviewer steps through the author's ordered files. Intro card sits above each diff.">
        <DCArtboard id="a-story"      label="A · Quiet"        width={W} height={H}><A_StorylineReview /></DCArtboard>
        <DCArtboard id="b-story"      label="B · Source list"  width={W} height={H}><B_StorylineReview /></DCArtboard>
      </DCSection>

      <DCSection id="publish-review" title="5 · Publish review" subtitle="Summary + review state (approve / comment / request changes), with optional GitHub publish.">
        <DCArtboard id="a-publish"    label="A · Quiet"        width={W} height={H}><A_PublishReview /></DCArtboard>
        <DCArtboard id="b-publish"    label="B · Source list"  width={W} height={H}><B_PublishReview /></DCArtboard>
      </DCSection>
    </DesignCanvas>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
