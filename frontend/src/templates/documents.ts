export const DOCUMENT_TEMPLATES = {
  blank: {
    name: 'Blank Document',
    description: 'Start with an empty document',
    content: `<h1>Untitled Document</h1><p></p>`,
  },
  report: {
    name: 'Report',
    description: 'Professional report with sections',
    content: `
      <h1 style="text-align: center">Report Title</h1>
      <p style="text-align: center"><em>Author Name</em></p>
      <p style="text-align: center"><em>Date</em></p>
      <p></p>
      <h2>1. Executive Summary</h2>
      <p>Provide a brief overview of the report's key findings and recommendations.</p>
      <p></p>
      <h2>2. Introduction</h2>
      <p>Describe the background, objectives, and scope of this report.</p>
      <p></p>
      <h2>3. Methodology</h2>
      <p>Explain the methods and approach used.</p>
      <p></p>
      <h2>4. Findings</h2>
      <p>Present the main findings and analysis.</p>
      <p></p>
      <h2>5. Conclusions</h2>
      <p>Summarize the key conclusions drawn from the findings.</p>
      <p></p>
      <h2>6. Recommendations</h2>
      <p>Provide actionable recommendations based on the conclusions.</p>
    `,
  },
  proposal: {
    name: 'Proposal',
    description: 'Project proposal template',
    content: `
      <h1 style="text-align: center">Project Proposal</h1>
      <p style="text-align: center"><strong>Prepared by:</strong> Your Name</p>
      <p style="text-align: center"><strong>Date:</strong> ${new Date().toLocaleDateString()}</p>
      <p></p>
      <h2>Project Overview</h2>
      <p>Describe the project and its objectives.</p>
      <p></p>
      <h2>Problem Statement</h2>
      <p>Define the problem this project aims to solve.</p>
      <p></p>
      <h2>Proposed Solution</h2>
      <p>Outline the proposed solution and approach.</p>
      <p></p>
      <h2>Timeline</h2>
      <p>Provide a high-level timeline with key milestones.</p>
      <p></p>
      <h2>Budget</h2>
      <p>Detail the estimated costs and resource requirements.</p>
      <p></p>
      <h2>Expected Outcomes</h2>
      <p>Describe the expected results and benefits.</p>
    `,
  },
  letter: {
    name: 'Formal Letter',
    description: 'Formal business letter',
    content: `
      <p style="text-align: right">[Your Address]</p>
      <p style="text-align: right">[City, State ZIP]</p>
      <p style="text-align: right">[Date]</p>
      <p></p>
      <p>[Recipient Name]</p>
      <p>[Recipient Title]</p>
      <p>[Company/Organization]</p>
      <p>[Address]</p>
      <p></p>
      <p>Dear [Recipient],</p>
      <p></p>
      <p>[Body of the letter. State your purpose clearly in the first paragraph.]</p>
      <p></p>
      <p>[Provide supporting details in subsequent paragraphs.]</p>
      <p></p>
      <p>[Conclude with a call to action or summary.]</p>
      <p></p>
      <p>Sincerely,</p>
      <p></p>
      <p>[Your Name]</p>
      <p>[Your Title]</p>
    `,
  },
  academic: {
    name: 'Academic Paper',
    description: 'Academic paper with citations',
    content: `
      <h1 style="text-align: center">Paper Title</h1>
      <p style="text-align: center"><em>Author Name<sup>1</sup></em></p>
      <p style="text-align: center"><em><sup>1</sup>Institution, City, Country</em></p>
      <p></p>
      <h2>Abstract</h2>
      <p>Write a concise summary of the paper (150-300 words).</p>
      <p></p>
      <p><strong>Keywords:</strong> keyword1, keyword2, keyword3</p>
      <p></p>
      <h2>1. Introduction</h2>
      <p>Introduce the research topic and state the research questions or hypotheses.</p>
      <p></p>
      <h2>2. Literature Review</h2>
      <p>Review relevant prior work and identify gaps.</p>
      <p></p>
      <h2>3. Methodology</h2>
      <p>Describe the research methods, data collection, and analysis approach.</p>
      <p></p>
      <h2>4. Results</h2>
      <p>Present findings with supporting data.</p>
      <p></p>
      <h2>5. Discussion</h2>
      <p>Interpret results, discuss implications, and address limitations.</p>
      <p></p>
      <h2>6. Conclusion</h2>
      <p>Summarize contributions and suggest future research directions.</p>
      <p></p>
      <h2>References</h2>
      <p>[1] Author, A. (Year). Title. Journal, Volume(Issue), Pages.</p>
    `,
  },
  meeting: {
    name: 'Meeting Notes',
    description: 'Meeting agenda and action items',
    content: `
      <h1>Meeting Notes</h1>
      <p><strong>Date:</strong> [Date]</p>
      <p><strong>Attendees:</strong> [Names]</p>
      <p><strong>Location:</strong> [Room / Video Link]</p>
      <p></p>
      <h2>Agenda</h2>
      <ol><li><p>Topic 1</p></li><li><p>Topic 2</p></li><li><p>Topic 3</p></li></ol>
      <p></p>
      <h2>Discussion</h2>
      <p>Summarize the key discussion points here.</p>
      <p></p>
      <h2>Decisions</h2>
      <ul><li><p>Decision 1</p></li><li><p>Decision 2</p></li></ul>
      <p></p>
      <h2>Action Items</h2>
      <table><tr><th>Task</th><th>Owner</th><th>Due Date</th></tr><tr><td>Action item 1</td><td>Name</td><td>Date</td></tr><tr><td>Action item 2</td><td>Name</td><td>Date</td></tr></table>
      <p></p>
      <h2>Next Meeting</h2>
      <p>[Date and time of next meeting]</p>
    `,
  },
  resume: {
    name: 'Resume',
    description: 'Professional resume / CV',
    content: `
      <h1 style="text-align: center">[Your Full Name]</h1>
      <p style="text-align: center">[Email] | [Phone] | [City, State] | [LinkedIn URL]</p>
      <p></p>
      <h2>Professional Summary</h2>
      <p>Experienced professional with expertise in [field]. Proven track record of [achievement]. Seeking to leverage skills in [target role].</p>
      <p></p>
      <h2>Experience</h2>
      <h3>[Job Title] — [Company Name]</h3>
      <p><em>[Start Date] – [End Date]</em></p>
      <ul><li><p>Accomplishment or responsibility 1</p></li><li><p>Accomplishment or responsibility 2</p></li><li><p>Accomplishment or responsibility 3</p></li></ul>
      <p></p>
      <h3>[Job Title] — [Company Name]</h3>
      <p><em>[Start Date] – [End Date]</em></p>
      <ul><li><p>Accomplishment or responsibility 1</p></li><li><p>Accomplishment or responsibility 2</p></li></ul>
      <p></p>
      <h2>Education</h2>
      <h3>[Degree] — [University]</h3>
      <p><em>[Graduation Year]</em></p>
      <p></p>
      <h2>Skills</h2>
      <p>[Skill 1], [Skill 2], [Skill 3], [Skill 4], [Skill 5]</p>
    `,
  },
  newsletter: {
    name: 'Newsletter',
    description: 'Newsletter or blog article',
    content: `
      <h1>[Newsletter Title]</h1>
      <p><em>Issue #X — [Date]</em></p>
      <p></p>
      <h2>Highlights</h2>
      <p>Welcome to this issue! Here's what we're covering:</p>
      <ul><li><p>Topic 1</p></li><li><p>Topic 2</p></li><li><p>Topic 3</p></li></ul>
      <p></p>
      <h2>Feature Story</h2>
      <p>Write the main article or announcement here. Keep it engaging and concise.</p>
      <p></p>
      <h2>Updates</h2>
      <p>Share recent news, product updates, or team highlights.</p>
      <p></p>
      <h2>Upcoming Events</h2>
      <ul><li><p>[Event 1] — [Date]</p></li><li><p>[Event 2] — [Date]</p></li></ul>
      <p></p>
      <p style="text-align: center"><em>Thanks for reading! Reply with feedback or questions.</em></p>
    `,
  },
}
