use crate::*;
/// Dispatches domain operations after the host has bound an exact credential grant.
pub(crate) async fn dispatch(client: &GitHub, request: GitHubRequest) -> Result<GitHubResponse> {
    match request {
        GitHubRequest::SearchRepositories { query, page } => client
            .search_repositories(&query, page)
            .await
            .map(GitHubResponse::SearchRepositories),
        GitHubRequest::CreateRepository {
            name,
            description,
            visibility,
        } => client
            .create_repository(&name, &description, visibility)
            .await
            .map(GitHubResponse::CreateRepository),
        GitHubRequest::RepositoryBranches { repository, page } => client
            .repository_branches(&repository, page)
            .await
            .map(GitHubResponse::RepositoryBranches),
        GitHubRequest::BranchProtection { repository } => client
            .branch_protection(&repository)
            .await
            .map(GitHubResponse::BranchProtection),
        GitHubRequest::ShareLink(_) => Err(Error::InvalidInput(
            "Link generation does not require an account".into(),
        )),
        GitHubRequest::Commit { repository, sha } => client
            .commit(&repository, &sha)
            .await
            .map(GitHubResponse::Commit),
        GitHubRequest::Issues {
            repository,
            state,
            page,
        } => client
            .issues(&repository, state, page)
            .await
            .map(GitHubResponse::Issues),
        GitHubRequest::SearchIssues {
            repository,
            state,
            query,
            page,
        } => client
            .search_issues(&repository, state, &query, page)
            .await
            .map(GitHubResponse::SearchIssues),
        GitHubRequest::Issue { repository, number } => client
            .issue(&repository, number)
            .await
            .map(GitHubResponse::Issue),
        GitHubRequest::Comments {
            repository,
            number,
            page,
        } => client
            .comments(&repository, number, page)
            .await
            .map(GitHubResponse::Comments),
        GitHubRequest::CreateIssue {
            repository,
            request,
        } => client
            .create_issue(&repository, request.as_borrowed())
            .await
            .map(GitHubResponse::CreateIssue),
        GitHubRequest::UpdateIssue {
            repository,
            number,
            update,
        } => client
            .update_issue(&repository, number, update.as_borrowed())
            .await
            .map(GitHubResponse::UpdateIssue),
        GitHubRequest::CreateComment {
            repository,
            number,
            body,
        } => client
            .create_comment(&repository, number, &body)
            .await
            .map(GitHubResponse::CreateComment),
        GitHubRequest::UpdateComment {
            repository,
            comment_id,
            body,
        } => client
            .update_comment(&repository, comment_id, &body)
            .await
            .map(GitHubResponse::UpdateComment),
        GitHubRequest::DeleteComment {
            repository,
            comment_id,
        } => client
            .delete_comment(&repository, comment_id)
            .await
            .map(GitHubResponse::DeleteComment),
        GitHubRequest::UpdateIssueLabelColor {
            repository,
            name,
            color,
        } => client
            .update_issue_label_color(&repository, &name, &color)
            .await
            .map(GitHubResponse::UpdateIssueLabelColor),
        GitHubRequest::AutomaticIssueCandidates {
            repository,
            labels,
            assignee,
            limit,
        } => client
            .automatic_issue_candidates(&repository, &labels, assignee.as_deref(), limit)
            .await
            .map(GitHubResponse::AutomaticIssueCandidates),
        GitHubRequest::UnassignIssue {
            repository,
            number,
            owner,
        } => client
            .unassign_issue(&repository, number, &owner)
            .await
            .map(GitHubResponse::UnassignIssue),
        GitHubRequest::CloseCompletedIssue { repository, number } => client
            .close_completed_issue(&repository, number)
            .await
            .map(GitHubResponse::CloseCompletedIssue),
        GitHubRequest::IssueRepository { repository } => client
            .issue_repository(&repository)
            .await
            .map(GitHubResponse::IssueRepository),
        GitHubRequest::IssueMetadata { repository, number } => client
            .issue_metadata(&repository, number)
            .await
            .map(GitHubResponse::IssueMetadata),
        GitHubRequest::IssueLabels { repository } => client
            .issue_labels(&repository)
            .await
            .map(GitHubResponse::IssueLabels),
        GitHubRequest::IssueAssignees { repository } => client
            .issue_assignees(&repository)
            .await
            .map(GitHubResponse::IssueAssignees),
        GitHubRequest::CreateIssueLabel {
            repository,
            name,
            color,
        } => client
            .create_issue_label(&repository, &name, &color)
            .await
            .map(GitHubResponse::CreateIssueLabel),
        GitHubRequest::AssignIssue {
            repository,
            number,
            login,
        } => client
            .assign_issue(&repository, number, &login)
            .await
            .map(GitHubResponse::AssignIssue),
        GitHubRequest::SyncIssueLabels {
            repository,
            number,
            managed,
            desired,
            expected,
        } => client
            .sync_issue_labels(&repository, number, &managed, desired.as_deref(), &expected)
            .await
            .map(GitHubResponse::SyncIssueLabels),
        GitHubRequest::LinkedIssueBranches {
            repository,
            issue_id,
        } => client
            .linked_issue_branches(&repository, &issue_id)
            .await
            .map(GitHubResponse::LinkedIssueBranches),
        GitHubRequest::CreateLinkedIssueBranch {
            repository,
            issue_id,
            name,
            commit,
        } => client
            .create_linked_issue_branch(&repository, &issue_id, &name, &commit)
            .await
            .map(GitHubResponse::CreateLinkedIssueBranch),
        GitHubRequest::Repository { repository } => client
            .repository(&repository)
            .await
            .map(GitHubResponse::Repository),
        GitHubRequest::PullRequests {
            repository,
            state,
            page,
            head,
        } => client
            .pull_requests(&repository, state, page, head.as_deref())
            .await
            .map(GitHubResponse::PullRequests),
        GitHubRequest::PullRequestFiles {
            repository,
            number,
            page,
        } => client
            .pull_request_files(&repository, number, page)
            .await
            .map(GitHubResponse::PullRequestFiles),
        GitHubRequest::PullRequestReviews {
            repository,
            number,
            page,
        } => client
            .pull_request_reviews(&repository, number, page)
            .await
            .map(GitHubResponse::PullRequestReviews),
        GitHubRequest::ReviewPullRequest {
            repository,
            number,
            commit,
            event,
            body,
            comments,
        } => client
            .review_pull_request(&repository, number, &commit, event, &body, &comments)
            .await
            .map(GitHubResponse::ReviewPullRequest),
        GitHubRequest::MergePullRequest {
            repository,
            number,
            commit,
            method,
        } => client
            .merge_pull_request(&repository, number, &commit, method)
            .await
            .map(GitHubResponse::MergePullRequest),
        GitHubRequest::EnableAutoMerge {
            repository,
            pull_request,
            method,
        } => client
            .enable_auto_merge(&repository, &pull_request, method)
            .await
            .map(GitHubResponse::EnableAutoMerge),
        GitHubRequest::MergeOptions { repository } => client
            .merge_options(&repository)
            .await
            .map(GitHubResponse::MergeOptions),
        GitHubRequest::FindPullRequest {
            repository,
            head,
            base,
        } => client
            .find_pull_request(&repository, &head, &base)
            .await
            .map(GitHubResponse::FindPullRequest),
        GitHubRequest::Checks {
            repository,
            commit,
            page,
        } => client
            .checks(&repository, &commit, page)
            .await
            .map(GitHubResponse::Checks),
        GitHubRequest::PullRequest { repository, number } => client
            .pull_request(&repository, number)
            .await
            .map(GitHubResponse::PullRequest),
        GitHubRequest::CreatePullRequest {
            repository,
            request,
        } => client
            .create_pull_request(&repository, request.as_borrowed())
            .await
            .map(GitHubResponse::CreatePullRequest),
        GitHubRequest::UpdatePullRequest {
            repository,
            number,
            request,
        } => client
            .update_pull_request(&repository, number, request.as_borrowed())
            .await
            .map(GitHubResponse::UpdatePullRequest),
        GitHubRequest::RequestedReviewers { repository, number } => client
            .requested_reviewers(&repository, number)
            .await
            .map(GitHubResponse::RequestedReviewers),
        GitHubRequest::ChangeReviewers {
            repository,
            number,
            change,
            users,
            teams,
        } => client
            .change_reviewers(&repository, number, change, &users, &teams)
            .await
            .map(GitHubResponse::ChangeReviewers),
        GitHubRequest::UpdateReviewComment {
            repository,
            number,
            comment,
            body,
        } => client
            .update_review_comment(&repository, number, &comment, &body)
            .await
            .map(GitHubResponse::UpdateReviewComment),
        GitHubRequest::DeleteReviewComment {
            repository,
            number,
            comment,
        } => client
            .delete_review_comment(&repository, number, &comment)
            .await
            .map(GitHubResponse::DeleteReviewComment),
        GitHubRequest::ReviewDiff {
            repository,
            number,
            commit,
            page,
        } => client
            .review_diff(&repository, number, &commit, page)
            .await
            .map(GitHubResponse::ReviewDiff),
        GitHubRequest::FileContent {
            repository,
            commit,
            path,
        } => client
            .file_content(&repository, &commit, &path)
            .await
            .map(GitHubResponse::FileContent),
        GitHubRequest::ReviewThreads {
            repository,
            number,
            cursor,
        } => client
            .review_threads(&repository, number, cursor.as_deref())
            .await
            .map(GitHubResponse::ReviewThreads),
        GitHubRequest::ThreadComments {
            repository,
            number,
            thread,
            cursor,
        } => client
            .thread_comments(&repository, number, &thread, cursor.as_deref())
            .await
            .map(GitHubResponse::ThreadComments),
        GitHubRequest::ReplyReviewThread {
            repository,
            number,
            thread,
            body,
        } => client
            .reply_review_thread(&repository, number, &thread, &body)
            .await
            .map(GitHubResponse::ReplyReviewThread),
        GitHubRequest::ResolveReviewThread {
            repository,
            number,
            thread,
            state,
        } => client
            .resolve_review_thread(&repository, number, &thread, state)
            .await
            .map(GitHubResponse::ResolveReviewThread),
        GitHubRequest::CreateFork { repository, fork } => client
            .create_fork(&repository, &fork)
            .await
            .map(GitHubResponse::CreateFork),
        GitHubRequest::Notifications { filter, page } => client
            .notifications(filter, page)
            .await
            .map(GitHubResponse::Notifications),
        GitHubRequest::MarkNotificationRead { thread_id } => client
            .mark_notification_read(&thread_id)
            .await
            .map(GitHubResponse::MarkNotificationRead),
        GitHubRequest::MarkNotificationsRead => client
            .mark_notifications_read()
            .await
            .map(GitHubResponse::MarkNotificationsRead),
        GitHubRequest::ManagedSettings => client
            .managed_settings()
            .await
            .map(GitHubResponse::ManagedSettings),
        GitHubRequest::ReporterSearch { .. } | GitHubRequest::ReporterSubmit { .. } => Err(
            Error::InvalidInput("reporter requires its product target".into()),
        ),
    }
}
