import * as Menu from '@radix-ui/react-dropdown-menu';
import {Check, ChevronDown} from 'lucide-react';
import {createContext, useContext, useId} from 'react';

export const MultiSelectTheme = createContext('phosphor');

export function MultiSelect({
    label,
    values,
    options,
    onChange,
    multiple = true,
    disabled = false,
}: {
    label: string;
    values: string[];
    options: [string, string][];
    onChange: (values: string[]) => void;
    multiple?: boolean;
    disabled?: boolean;
}) {
    const theme = useContext(MultiSelectTheme);
    const id = useId();
    const selected = options.filter(([value]) => values.includes(value));
    function toggle(value: string) {
        if (!multiple || value === 'any') {
            onChange([value]);
            return;
        }
        const next = values.filter((v) => v !== 'any');
        onChange(
            next.includes(value)
                ? next.filter((v) => v !== value)
                : [...next, value],
        );
    }
    return (
        <div className="uc-input uc-multi-select">
            <span id={id} className="uc-label uc-input-label">
                {label}
            </span>
            <Menu.Root modal={false}>
                <Menu.Trigger
                    className="uc-multi-trigger uc-data"
                    aria-labelledby={id}
                    disabled={disabled}
                >
                    <span>
                        {selected.length
                            ? selected.map(([, name]) => name).join(', ')
                            : 'Any'}
                    </span>
                    <ChevronDown size={14} />
                </Menu.Trigger>
                <Menu.Portal>
                    <Menu.Content
                        className="usbcloud uc-multi-menu"
                        data-theme={theme}
                        align="start"
                        sideOffset={4}
                        collisionPadding={8}
                        aria-label={label}
                    >
                        {options.map(([value, name]) => (
                            <Menu.CheckboxItem
                                key={value}
                                className="uc-multi-option uc-data"
                                checked={values.includes(value)}
                                onCheckedChange={() => toggle(value)}
                                onSelect={(event) => {
                                    if (multiple) event.preventDefault();
                                }}
                            >
                                <span className="uc-multi-check">
                                    <Menu.ItemIndicator>
                                        <Check size={14} />
                                    </Menu.ItemIndicator>
                                </span>
                                {name}
                            </Menu.CheckboxItem>
                        ))}
                    </Menu.Content>
                </Menu.Portal>
            </Menu.Root>
        </div>
    );
}
