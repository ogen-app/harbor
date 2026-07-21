import { type SVGProps, type ComponentType } from 'react'
import { cn } from '@/lib/utils'

import AiStudioIcon from '@/assets/icons/ai_studio.svg'
import ClaudeIcon from '@/assets/icons/claude.svg'
import CloudflareIcon from '@/assets/icons/cloudflare.svg'
import GithubIcon from '@/assets/icons/github.svg'
import ArrowDownPointedIcon from '@/assets/icons/arrow_down_pointed.svg'
import ArrowLeftIcon from '@/assets/icons/arrow_left.svg'
import ArrowRightIcon from '@/assets/icons/arrow_right.svg'
import ArrowRightTopIcon from '@/assets/icons/arrow_right_top.svg'
import ArrowUpPointedIcon from '@/assets/icons/arrow_up_pointed.svg'
import BurgerIcon from '@/assets/icons/burger.svg'
import CalendarIcon from '@/assets/icons/calendar.svg'
import ChangeIcon from '@/assets/icons/change.svg'
import CheckIcon from '@/assets/icons/check.svg'
import ChevronDoubleLeftIcon from '@/assets/icons/chevron_double_left.svg'
import ChevronDoubleRightIcon from '@/assets/icons/chevron_double_right.svg'
import ChevronDownIcon from '@/assets/icons/chevron_down.svg'
import ChevronLeftIcon from '@/assets/icons/chevron_left.svg'
import ChevronRightIcon from '@/assets/icons/chevron_right.svg'
import ChevronUpIcon from '@/assets/icons/chevron_up.svg'
import CollapseTopIcon from '@/assets/icons/collapse_top.svg'
import CommentIcon from '@/assets/icons/comment.svg'
import Dots2VerticalIcon from '@/assets/icons/dots_2_vertical.svg'
import DotsDragVerticalIcon from '@/assets/icons/dots_drag_vertical.svg'
import EditIcon from '@/assets/icons/edit.svg'
import ExitIcon from '@/assets/icons/exit.svg'
import EmptyIcon from '@/assets/icons/empty.svg'
import FilterEmptyIcon from '@/assets/icons/filter_empty.svg'
import LayoutIcon from '@/assets/icons/layout.svg'
import NavDashboardIcon from '@/assets/icons/nav_dashboard.svg'
import NavIdeasIcon from '@/assets/icons/nav_ideas.svg'
import NavJournalIcon from '@/assets/icons/nav_journal.svg'
import NavPortfoliosIcon from '@/assets/icons/nav_portfolios.svg'
import NavScreeningIcon from '@/assets/icons/nav_screening.svg'
import NavStrategyIcon from '@/assets/icons/nav_strategy.svg'
import NavSettingsIcon from '@/assets/icons/nav_settings.svg'
import NavWatchlistIcon from '@/assets/icons/nav_watchlist.svg'
import PlusIcon from '@/assets/icons/plus.svg'
import RailwayIcon from '@/assets/icons/railway.svg'
import SearchIcon from '@/assets/icons/search.svg'
import SearchAnimateIcon from '@/assets/icons/search_animate.svg'
import SettingsIcon from '@/assets/icons/settings.svg'
import TrashBinIcon from '@/assets/icons/trash_bin.svg'
import TrendDownIcon from '@/assets/icons/trend_down.svg'
import TrendStableIcon from '@/assets/icons/trend_stable.svg'
import TrendUpIcon from '@/assets/icons/trend_up.svg'
import UncollapseTopIcon from '@/assets/icons/uncollapse_top.svg'
import WidgetMaximizeIcon from '@/assets/icons/widget_maximize.svg'
import WidgetMinimizeIcon from '@/assets/icons/widget_minimize.svg'
import XMarkIcon from '@/assets/icons/x_mark.svg'

export type IconName =
  | 'ai_studio'
  | 'claude'
  | 'cloudflare'
  | 'github'
  | 'arrow_down_pointed'
  | 'arrow_left'
  | 'arrow_right'
  | 'arrow_right_top'
  | 'arrow_up_pointed'
  | 'burger'
  | 'calendar'
  | 'change'
  | 'check'
  | 'chevron_double_left'
  | 'chevron_double_right'
  | 'chevron_down'
  | 'chevron_left'
  | 'chevron_right'
  | 'chevron_up'
  | 'collapse_top'
  | 'comment'
  | 'dots_2_vertical'
  | 'dots_drag_vertical'
  | 'edit'
  | 'exit'
  | 'empty'
  | 'filter_empty'
  | 'layout'
  | 'nav_dashboard'
  | 'nav_ideas'
  | 'nav_journal'
  | 'nav_portfolios'
  | 'nav_screening'
  | 'nav_settings'
  | 'nav_strategy'
  | 'nav_watchlist'
  | 'plus'
  | 'railway'
  | 'search'
  | 'search_animate'
  | 'settings'
  | 'trash_bin'
  | 'trend_down'
  | 'trend_stable'
  | 'trend_up'
  | 'uncollapse_top'
  | 'widget_maximize'
  | 'widget_minimize'
  | 'x_mark'

export type IconProps = {
  name: IconName
  className?: string
} & Omit<SVGProps<SVGSVGElement>, 'ref'>

type SvgComponent = ComponentType<SVGProps<SVGSVGElement>>

const icons: Record<IconName, SvgComponent> = {
  ai_studio: AiStudioIcon,
  claude: ClaudeIcon,
  cloudflare: CloudflareIcon,
  github: GithubIcon,
  arrow_down_pointed: ArrowDownPointedIcon,
  arrow_left: ArrowLeftIcon,
  arrow_right: ArrowRightIcon,
  arrow_right_top: ArrowRightTopIcon,
  arrow_up_pointed: ArrowUpPointedIcon,
  burger: BurgerIcon,
  calendar: CalendarIcon,
  change: ChangeIcon,
  check: CheckIcon,
  chevron_double_left: ChevronDoubleLeftIcon,
  chevron_double_right: ChevronDoubleRightIcon,
  chevron_down: ChevronDownIcon,
  chevron_left: ChevronLeftIcon,
  chevron_right: ChevronRightIcon,
  chevron_up: ChevronUpIcon,
  collapse_top: CollapseTopIcon,
  comment: CommentIcon,
  dots_2_vertical: Dots2VerticalIcon,
  dots_drag_vertical: DotsDragVerticalIcon,
  edit: EditIcon,
  exit: ExitIcon,
  empty: EmptyIcon,
  filter_empty: FilterEmptyIcon,
  layout: LayoutIcon,
  nav_dashboard: NavDashboardIcon,
  nav_ideas: NavIdeasIcon,
  nav_journal: NavJournalIcon,
  nav_portfolios: NavPortfoliosIcon,
  nav_screening: NavScreeningIcon,
  nav_settings: NavSettingsIcon,
  nav_strategy: NavStrategyIcon,
  nav_watchlist: NavWatchlistIcon,
  plus: PlusIcon,
  railway: RailwayIcon,
  search: SearchIcon,
  search_animate: SearchAnimateIcon,
  settings: SettingsIcon,
  trash_bin: TrashBinIcon,
  trend_down: TrendDownIcon,
  trend_stable: TrendStableIcon,
  trend_up: TrendUpIcon,
  uncollapse_top: UncollapseTopIcon,
  widget_maximize: WidgetMaximizeIcon,
  widget_minimize: WidgetMinimizeIcon,
  x_mark: XMarkIcon,
}

export function Icon({ name, className, ...props }: IconProps) {
  const IconComponent = icons[name]
  if (!IconComponent) return null
  return <IconComponent className={cn('inline-block', className)} {...props} />
}
